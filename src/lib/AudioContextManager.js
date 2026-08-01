/**
 * Singleton Web Audio Context manager
 * Handles browser compatibility and audio unlocking
 */
class AudioContextManager {
  constructor() {
    this.context = null;
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
    source.connect(this.context.destination);
    source.start(0);

    this.unlocked = true;
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
