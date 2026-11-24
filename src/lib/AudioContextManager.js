// How long a mute or unmute fades (seconds): short enough to feel instant,
// long enough not to click
const MUTE_RAMP_SECONDS = 0.02;

// The master limiter: a DynamicsCompressor set up as a limiter, so voices
// summing past full scale are held under it instead of clipping. Below the
// threshold it is transparent: a hard knee, and its makeup gain (Web Audio
// adds one, from the curve) taken back off after it (LIMITER_TRIM).
export const LIMITER = Object.freeze({
  threshold: -3, // dBFS
  knee: 0, // dB (hard)
  ratio: 20, // the most a DynamicsCompressor allows
  attack: 0.002, // seconds
  release: 0.15, // seconds
});

/**
 * The gain a DynamicsCompressor adds on its own (Web Audio spec, "makeup
 * gain"): (1 / the curve's gain at full scale) ^ 0.6. With a hard knee the
 * curve at 0 dBFS is threshold + (0 - threshold) / ratio.
 */
function limiterMakeup({ threshold, ratio }) {
  const fullRangeDb = threshold - threshold / ratio;
  return (1 / 10 ** (fullRangeDb / 20)) ** 0.6;
}

/**
 * Build the master limiter in `context`: a DynamicsCompressor and the gain
 * that takes its makeup back off, joined (input -> output). Null where the
 * context can't make a compressor (some test mocks): the master output then
 * goes straight to the destination, as it did before the limiter.
 * @param {BaseAudioContext} context
 * @returns {?{input: AudioNode, output: AudioNode}}
 */
export function createLimiter(context) {
  if (typeof context.createDynamicsCompressor !== 'function') return null;
  const limiter = context.createDynamicsCompressor();
  ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach((key) => {
    limiter[key].value = LIMITER[key];
  });
  const trim = context.createGain();
  trim.gain.value = 1 / limiterMakeup(LIMITER);
  limiter.connect(trim);
  return { input: limiter, output: trim };
}

/**
 * Singleton Web Audio Context manager
 * Handles browser compatibility and audio unlocking, and owns the master
 * output every live sound goes through (getOutput), which mutes it and,
 * through the master limiter, keeps the sum from clipping.
 */
class AudioContextManager {
  constructor() {
    this.context = null;
    this.output = null;
    this.limiter = null;
    this.muted = false;
    this.unlocked = false;
    this.gestureListenersInstalled = false;
  }

  getContext() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      this.unlockAudio();
    }
    return this.context;
  }

  unlockAudio() {
    if (this.unlocked) return;

    // Create silent buffer to unlock audio on iOS/Safari
    const buffer = this.context.createBuffer(1, 1, 22050);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.getOutput());
    source.start(0);

    this.unlocked = true;
  }

  /**
   * The master output of the live context: a GainNode, through the master
   * limiter (createLimiter), into its destination. Everything the library
   * plays live connects here, never to `destination` directly, so
   * setMuted() silences all of it and the limiter holds all of it under
   * full scale. (An OfflineAudioContext render keeps its own destination.)
   * @returns {GainNode}
   */
  getOutput() {
    const context = this.getContext();
    if (!this.output) {
      this.output = context.createGain();
      this.output.gain.value = this.muted ? 0 : 1;
      this.limiter = createLimiter(context);
      if (this.limiter) {
        this.output.connect(this.limiter.input);
        this.limiter.output.connect(context.destination);
      } else {
        this.output.connect(context.destination);
      }
    }
    return this.output;
  }

  /**
   * Mute or unmute everything played live, with a short fade (no click).
   * Only the output's gain moves: the context keeps running, so its clock
   * and everything scheduled on it carry on while muted. Safe to call
   * before any context exists: the output starts muted when it is made.
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = !!muted;
    if (!this.output) return;
    const { gain } = this.output;
    const target = this.muted ? 0 : 1;
    const now = this.context.currentTime;
    gain.cancelScheduledValues(now);
    if (this.context.state === 'running') {
      // Fade from wherever the gain is now (mid-fade, if toggled quickly)
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(target, now + MUTE_RAMP_SECONDS);
    } else {
      // A clock that isn't running would hold a fade until it starts
      gain.setValueAtTime(target, now);
      gain.value = target;
    }
  }

  /** Whether setMuted(true) is in force. */
  isMuted() {
    return this.muted;
  }

  getCurrentTime() {
    return this.getContext().currentTime;
  }

  /**
   * A context created outside a user gesture (e.g. via eager `initInstruments`
   * at page load) starts `suspended` and never resumes on its own. If so,
   * install one-time listeners on `document` (`pointerdown`, `keydown`,
   * `touchend`) that call `context.resume()` on the first gesture and remove
   * themselves. No-op if the context is already `running`, if `document`
   * isn't available (SSR), or if a set of listeners is already installed —
   * safe to call repeatedly (one set of listeners max).
   */
  resumeOnFirstGesture() {
    const context = this.getContext();
    if (context.state !== 'suspended') return;
    if (this.gestureListenersInstalled) return;
    if (typeof document === 'undefined') return;

    this.gestureListenersInstalled = true;

    const events = ['pointerdown', 'keydown', 'touchend'];
    const onGesture = () => {
      context.resume();
      events.forEach((type) => document.removeEventListener(type, onGesture));
      this.gestureListenersInstalled = false;
    };
    events.forEach((type) => document.addEventListener(type, onGesture));
  }
}

// Export singleton instance
const audioContextManager = new AudioContextManager();
export default audioContextManager;
