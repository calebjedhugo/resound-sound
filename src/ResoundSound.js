import pitchToFrequency from './utils/pitchToFrequency';
import SoundManager from './SoundManager';

/**
 * @class
 */
class ResoundSound {
  /**
   * @param {object} param0
   * @param {"sine"|"triangle"|"sawtooth"} param0.type
   */
  constructor({ type = 'sine', transients = {} }) {
    this.setSoundscape();
    this.transients = transients;
    this.type = type;
  }

  setSoundscape() {
    if (!window.resoundSoundscape) {
      const soundManager = new SoundManager();
      soundManager.verifySoundUnlocked();
      window.resoundSoundscape = soundManager.soundscape;
    }
    this.soundScape = window.resoundSoundscape;
  }

  connectOscillator() {
    this.oscillator = this.soundScape.createOscillator();
    this.oscillator.connect(this.soundScape.destination);
    this.oscillator.type = this.type;
  }

  connectGainNode() {
    this.gainNode = this.soundScape.createGain();
    this.oscillator.connect(this.gainNode);
    this.gainNode.connect(this.soundScape.destination);
  }

  setPitch(pitch) {
    this.oscillator.frequency.setValueAtTime(
      pitchToFrequency(pitch),
      this.soundScape.currentTime
    );
  }

  setVolume({ dynamic = 'mf', length }) {
    const lengthInSeconds = length / 1000;
    const { attack = 0.02, decay = 0.2, release = 0.05 } = this.transients;
    const {
      gainNode: { gain },
      soundScape: { currentTime },
    } = this;
    const gainLevel = 1; // do something with dynamics here
    gain.setValueAtTime(0, currentTime);
    gain.linearRampToValueAtTime(gainLevel, currentTime + attack);
    gain.linearRampToValueAtTime(
      gainLevel * Math.exp(-decay * lengthInSeconds),
      currentTime + attack + lengthInSeconds
    );
    gain.linearRampToValueAtTime(
      0,
      currentTime + attack + lengthInSeconds + release
    );
  }

  play({ length = 3000, pitch = 'A4', dynamic, articulation } = {}) {
    if (this.oscillator) {
      this.oscillator.stop();
    }
    this.connectOscillator();
    this.setPitch(pitch);
    this.connectGainNode();
    this.setVolume({ dynamic, length });

    // Start the playback
    this.oscillator.start();

    setTimeout(() => {
      this.oscillator.stop();
    }, length);
  }
}

export default ResoundSound;
