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

  /**
   * Creates the oscillator, sets it to this.oscillator, and connects it to passed value
   * @param {object} connectTo - the node that the oscillator will connect to. Defaults to this.soundScape.destination.
   * @returns {object} the constructed oscillator
   */
  connectOscillator(connectTo = this.soundScape.destination) {
    this.oscillator = this.soundScape.createOscillator();
    this.oscillator.connect(connectTo);
    this.oscillator.type = this.type;
    return this.oscillator;
  }

  /**
   * Creates the gain node, sets it to this.gainNode, and connects it to passed value
   * @param {object} connectTo  - the node that the oscillator will connect to. Defaults to this.soundScape.destination.
   * @returns {object} the constructed gain node
   */
  connectGainNode(connectTo = this.soundScape.destination) {
    this.gainNode = this.soundScape.createGain();
    this.gainNode.connect(connectTo);
    return this.gainNode;
  }

  setPitch(pitch) {
    this.oscillator.frequency.setValueAtTime(
      pitchToFrequency(pitch),
      this.soundScape.currentTime
    );
  }

  setVolume({ dynamic = 'mf', length }) {
    const lengthInSeconds = length / 1000;
    const { attack = 0.02, decay = 0.025, release = 0.05 } = this.transients;
    const {
      gainNode: { gain },
      soundScape: { currentTime },
    } = this;
    const gainLevel = 1; // do something with dynamics here
    gain.setValueAtTime(0, currentTime);
    gain.linearRampToValueAtTime(gainLevel, currentTime + attack);

    const steps = 100; // Number of steps for the decay

    const decayInterval = lengthInSeconds / steps;

    let currentGain = gainLevel;
    for (let i = 0; i < steps; i++) {
      currentGain *= Math.exp(-decay * decayInterval * i);
      const time = currentTime + attack + i * decayInterval;
      gain.linearRampToValueAtTime(currentGain, time);
    }
    gain.linearRampToValueAtTime(
      0,
      currentTime + attack + lengthInSeconds + release
    );
  }

  play({ length = 3000, pitch = 'A4', dynamic, articulation } = {}) {
    if (this.oscillator) {
      this.oscillator.stop();
    }
    // Connect gain node to the soundscape
    this.connectGainNode();
    this.setVolume({ dynamic, length });

    // Connect oscillator to the gain node
    this.connectOscillator(this.gainNode);
    this.setPitch(pitch);

    // Start the playback
    this.oscillator.start();

    setTimeout(() => {
      this.oscillator.stop();
    }, length);
  }
}

export default ResoundSound;
