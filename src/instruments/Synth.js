import { getFrequency } from '../lib/noteFrequencies';
import { applyEnvelope } from '../lib/Envelope';
import Instrument from './Instrument';

/**
 * Generic subtractive synth.
 *
 * The shared graph for every templated instrument: detuned oscillators of a
 * configurable waveform, sine harmonics at integer multiples, run through one
 * biquad filter, gated by an ADSR envelope.
 *
 * Subclass and override the defaults in your constructor to ship a new sound.
 */
class Synth extends Instrument {
  constructor(id = 'synth', recordingCallback = null) {
    super(id, recordingCallback);

    this.envelope = { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 };
    this.harmonics = [];
    this.detune = [0];
    this.waveform = 'sine';
    this.filterType = 'lowpass';
    this.filterCutoff = 5000;
  }

  startNote(pitch, duration) {
    const frequency = getFrequency(pitch);
    const { currentTime } = this.context;

    const volumeGain = this.context.createGain();
    volumeGain.gain.value = this.volumeMultiplier;
    volumeGain.connect(this.context.destination);

    const envelopeGain = this.context.createGain();
    envelopeGain.connect(volumeGain);
    applyEnvelope(envelopeGain, currentTime, this.envelope, duration);

    const filter = this.context.createBiquadFilter();
    filter.type = this.filterType;
    filter.frequency.setValueAtTime(this.filterCutoff, currentTime);
    filter.connect(envelopeGain);

    this.detune.forEach((cents) => {
      const osc = this.context.createOscillator();
      osc.type = this.waveform;
      osc.frequency.setValueAtTime(frequency, currentTime);
      osc.detune.setValueAtTime(cents, currentTime);
      osc.connect(filter);
      osc.start(currentTime);
      osc.stop(currentTime + duration / 1000);
      this.trackOscillator(osc, volumeGain, duration);
    });

    this.harmonics.forEach(({ multiple, volume }) => {
      const harmonic = this.context.createOscillator();
      harmonic.type = 'sine';
      harmonic.frequency.setValueAtTime(frequency * multiple, currentTime);

      const harmonicGain = this.context.createGain();
      harmonicGain.gain.setValueAtTime(volume, currentTime);

      harmonic.connect(harmonicGain);
      harmonicGain.connect(filter);
      harmonic.start(currentTime);
      harmonic.stop(currentTime + duration / 1000);
      this.trackOscillator(harmonic, volumeGain, duration);
    });
  }
}

export default Synth;
