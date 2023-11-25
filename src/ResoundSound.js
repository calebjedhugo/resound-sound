import pitchToFrequency from './utils/pitchToFrequency';
import SoundManager from './SoundManager';

const defaultAttack = 0.02;
const defaultDecay = 0.025;
const defaultRelease = 0.05;

/**
 * @class
 */
class ResoundSound {
  /**
   * @param {object} param0
   * @param {"sine"|"triangle"|"sawtooth"} param0.type
   */
  constructor({ type = 'sine', transients: { attack, decay, release } = {} }) {
    this.setSoundscape();
    this.transients = {
      attack: attack || defaultAttack,
      decay: decay || defaultDecay,
      release: release || defaultRelease,
    };
    this.type = type;
    this.soundingNodes = {};
    this.stopTimouts = {};
    this.primedNodeSet = {};

    // get ready to play the first note.
    this.prime();
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
   * Creates the gain node, sets it to this.gainNode, and connects it to passed value
   * @param {object} connectTo  - the node that the oscillator will connect to. Defaults to this.soundScape.destination.
   * @returns {object} the constructed gain node
   */
  connectGainNode(connectTo = this.soundScape.destination) {
    this.primedNodeSet.gainNode = this.soundScape.createGain();
    this.primedNodeSet.gainNode.connect(connectTo);
    return this.primedNodeSet.gainNode;
  }

  /**
   * Creates the oscillator, sets it to this.oscillator, and connects it to passed value
   * @param {object} connectTo - the node that the oscillator will connect to. Defaults to this.soundScape.destination.
   * @returns {object} the constructed oscillator
   */
  connectOscillator(connectTo = this.soundScape.destination) {
    this.primedNodeSet.oscillator = this.soundScape.createOscillator();
    this.primedNodeSet.oscillator.connect(connectTo);
    this.primedNodeSet.oscillator.type = this.type;
    return this.primedNodeSet.oscillator;
  }

  setPitch(pitch) {
    this.primedNodeSet.oscillator.frequency.setValueAtTime(
      pitchToFrequency(pitch),
      this.soundScape.currentTime
    );
  }

  setVolume({ dynamic = 'mf', length }) {
    const lengthInSeconds = length / 1000;
    const { attack, decay, release } = this.transients;
    const {
      primedNodeSet: {
        gainNode: { gain },
      },
      soundScape: { currentTime },
    } = this;
    const gainLevel = 0.5; // do something with dynamics here
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

  prime() {
    // clear out the old object
    this.primedNodeSet = {};

    // Connect gain node to the soundscape
    const gainNode = this.connectGainNode();

    // Connect oscillator to the gain node
    this.connectOscillator(gainNode);
  }

  stopSingle(pitch) {
    if (!pitch) return;
    const { gainNode: { gain } = {}, oscillator } =
      this.soundingNodes[pitch] || {};
    const {
      soundScape: { currentTime },
      transients: { release },
    } = this;
    if (this.soundingNodes[pitch]) {
      // cleanly stop the old node
      gain.linearRampToValueAtTime(0, currentTime + release);
      // schedule stopping the oscillator after gain is zero
      setTimeout(() => oscillator.stop(), release * 1000);
    } // else do nothing
  }

  stop(pitch) {
    const { release } = this.transients;
    if (pitch) {
      this.stopSingle(pitch);
    } else
      Object.keys(this.soundingNodes).forEach((pitch) =>
        this.stopSingle(pitch)
      );
  }

  play({ length = 3000, pitch = 'A4', dynamic, articulation } = {}) {
    // stop the playback of the same pitch
    this.stop(pitch);

    this.setVolume({ dynamic, length });
    this.setPitch(pitch);

    // Start the playback.
    this.primedNodeSet.oscillator.start();

    // clear the timeout for old node
    clearTimeout(this.stopTimouts[pitch]);

    // push the new node to soundingNodes
    this.soundingNodes[pitch] = this.primedNodeSet;

    this.stopTimouts[pitch] = setTimeout(() => {
      this.stop(pitch);
    }, length);

    // prepare for next note
    this.prime();
  }
}

export default ResoundSound;
