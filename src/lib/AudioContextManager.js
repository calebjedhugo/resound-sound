// How long a mute or unmute fades (seconds): short enough to feel instant,
// long enough not to click
const MUTE_RAMP_SECONDS = 0.02;

/**
 * Singleton Web Audio Context manager
 * Handles browser compatibility and audio unlocking, and owns the master
 * output every live sound goes through (getOutput), which mutes it.
 */
class AudioContextManager {
  constructor() {
    this.context = null;
    this.output = null;
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
   * The master output of the live context: a GainNode into its
   * destination. Everything the library plays live connects here, never
   * to `destination` directly, so setMuted() silences all of it. (An
   * OfflineAudioContext render keeps its own destination.)
   * @returns {GainNode}
   */
  getOutput() {
    const context = this.getContext();
    if (!this.output) {
      this.output = context.createGain();
      this.output.gain.value = this.muted ? 0 : 1;
      this.output.connect(context.destination);
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
