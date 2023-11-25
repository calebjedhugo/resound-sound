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
    const { attack = 0.02, decay = 0.025, release = 0.05 } = this.transients;
    const {
      primedNodeSet: {
        gainNode: { gain },
      },
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

  prime() {
    // clear out the old object
    this.primedNodeSet = {};

    // Connect gain node to the soundscape
    const gainNode = this.connectGainNode();

    // Connect oscillator to the gain node
    this.connectOscillator(gainNode);
  }

  stop(pitch) {
    if (pitch) {
      if (this.soundingNodes[pitch]) {
        this.soundingNodes[pitch].oscillator.stop();
      } // else do nothing
    } else
      Object.values(this.soundingNodes).forEach(({ oscillator }) =>
        oscillator.stop()
      );
  }

  play({ length = 3000, pitch = 'A4', dynamic, articulation } = {}) {
    this.setVolume({ dynamic, length });
    this.setPitch(pitch);

    // Start the playback (This needs to happen asap!)
    this.primedNodeSet.oscillator.start();

    // stop the playback of the same pitch
    this.stop(pitch);

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
