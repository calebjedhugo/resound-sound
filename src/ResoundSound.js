import pitchToFrequency from './utils/pitchToFrequency';
import SoundManager from './SoundManager';

/**
 * @class
 */
class ResoundSound {
  /**
   * @param {"sine"|"triangle"|"sawtooth"} instrument
   */
  constructor(instrument = 'sine') {
    if (!window.resoundSoundscape) {
      const soundManager = new SoundManager();
      soundManager.verifySoundUnlocked();
      window.resoundSoundscape = soundManager.soundscape;
    }
    this.soundScape = window.resoundSoundscape;
    this.oscillator = this.soundScape.createOscillator();
    this.oscillator.type = instrument;
  }

  setPitch(pitch) {
    console.log(pitchToFrequency(pitch));
    this.oscillator.frequency.setValueAtTime(
      pitchToFrequency(pitch),
      this.soundScape.currentTime
    );
  }

  play({ length = 3000, pitch = 'A4' } = {}) {
    this.oscillator.connect(this.soundScape.destination);
    this.setPitch(pitch);
    this.oscillator.start();

    setTimeout(() => {
      this.oscillator.stop();
    }, length);
  }
}

export default ResoundSound;
