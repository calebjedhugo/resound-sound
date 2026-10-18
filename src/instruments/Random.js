import { getFrequency } from '../lib/noteFrequencies';
import { applyEnvelope } from '../lib/Envelope';
import Instrument from './Instrument';

/**
 * Random waveform selection (weighted toward smoother sounds)
 */
function generateRandomWaveform() {
  const waveforms = ['sine', 'sine', 'triangle', 'triangle', 'sawtooth', 'square'];
  return waveforms[Math.floor(Math.random() * waveforms.length)];
}

/**
 * Random filter cutoff (500-5000 Hz for brightness variation)
 */
function generateRandomFilterCutoff() {
  return 500 + Math.random() * 4500;
}

/**
 * Random ADSR envelope
 */
function generateRandomEnvelope() {
  return {
    attack: 0.01 + Math.random() * 0.09, // 10-100ms
    decay: 0.05 + Math.random() * 0.15, // 50-200ms
    sustain: 0.3 + Math.random() * 0.4, // 0.3-0.7
    release: 0.05 + Math.random() * 0.25, // 50-300ms
  };
}

/**
 * Random harmonics (1-3 overtones at low volume)
 */
function generateRandomHarmonics() {
  const count = 1 + Math.floor(Math.random() * 3); // 1-3 harmonics
  const harmonics = [];
  for (let i = 0; i < count; i += 1) {
    harmonics.push({
      multiple: 2 + i, // 2x, 3x, 4x fundamental
      volume: 0.1 + Math.random() * 0.2, // 0.1-0.3
    });
  }
  return harmonics;
}

/**
 * Sine coefficient k of a built-in oscillator type's Fourier series (Web
 * Audio spec, "Oscillator Coefficients"). Every built-in wave is odd, so it
 * has no cosine terms.
 */
function builtinCoefficient(waveform, k) {
  switch (waveform) {
    case 'square':
      return k % 2 ? 4 / (Math.PI * k) : 0;
    case 'sawtooth':
      return ((k % 2 ? 1 : -1) * 2) / (Math.PI * k);
    case 'triangle':
      return k % 2 ? (8 * Math.sin((Math.PI * k) / 2)) / (Math.PI * k) ** 2 : 0;
    default: // sine
      return k === 1 ? 1 : 0;
  }
}

/**
 * Samples per cycle of the browser's wavetables at a sample rate
 * (Chromium's and WebKit's PeriodicWave).
 */
function wavetableSize(sampleRate) {
  if (sampleRate <= 24000) return 2048;
  if (sampleRate <= 88200) return 4096;
  return 16384;
}

// The largest wavetable a voice is built on. A voice costs ~0.6 MB of
// wavetable and ~1-1.5 ms to build at 44.1-48 kHz, but ~2.8 MB and ~4.3 ms
// on the 16384-sample tables above 88.2 kHz (Chrome 152, 2026-10-17): there
// a note builds the graph a voice folds together instead, which keeps no
// per-pitch tables
const MAX_VOICE_TABLE_SIZE = 4096;

// The sample where each built-in wave's full-band table peaks: beside the
// square's and the sawtooth's jumps (the Gibbs overshoot), on the crest of
// the others. Checked by brute force at all three table sizes.
const PEAK_SAMPLE = {
  sine: (size) => size / 4,
  triangle: (size) => size / 4,
  square: () => 1,
  sawtooth: (size) => size / 2 - 1,
};

const builtinPeaks = new Map(); // `${waveform}:${tableSize}` -> peak

/**
 * A built-in wave is its series NORMALIZED: divided by the highest sample of
 * its full-band table (~1.179 for the square and the sawtooth, whose partial
 * sums overshoot their nominal ±1). A periodic wave built with normalization
 * disabled has to divide by the same peak to sound the same.
 */
function builtinPeak(waveform, sampleRate) {
  const size = wavetableSize(sampleRate);
  const key = `${waveform}:${size}`;
  if (!builtinPeaks.has(key)) {
    const at = PEAK_SAMPLE[waveform](size);
    let sum = 0;
    for (let k = 1; k < size / 2; k += 1) {
      sum += builtinCoefficient(waveform, k) * Math.sin((2 * Math.PI * k * at) / size);
    }
    builtinPeaks.set(key, Math.abs(sum));
  }
  return builtinPeaks.get(key);
}

// The note lowpass's Q: the BiquadFilterNode default, which for a lowpass is
// in dB
const LOWPASS_Q_DB = 1;

/**
 * The note lowpass's coefficients as the browser computes them (Web Audio
 * spec, BiquadFilterNode "lowpass"), normalized to a0 = 1.
 */
function lowpassCoefficients(cutoff, sampleRate) {
  const theta = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(theta) / (2 * 10 ** (LOWPASS_Q_DB / 20));
  const cos = Math.cos(theta);
  const a0 = 1 + alpha;
  const b = (1 - cos) / 2 / a0;
  return { b0: b, b1: 2 * b, b2: b, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

// The onset transient ends once two samples in a row are below this
// (-140 dB re full scale), or at the time cap (a 500 Hz lowpass takes ~12 ms)
const TRANSIENT_FLOOR = 1e-7;
const TRANSIENT_MAX_SECONDS = 0.05;

/**
 * What the lowpass adds at a note's onset. A filter starting from rest
 * reaches the steady state the wave holds only after a brief transient: the
 * difference follows the filter's own recursion, from rest minus the steady
 * state's last two samples before the onset (input x, filtered output y).
 * @param {{b1, b2, a1, a2}} filter - lowpassCoefficients()
 * @param {{x1, x2, y1, y2}} before - steady-state samples at n = -1, -2
 * @returns {Float32Array}
 */
function onsetTransient({ b1, b2, a1, a2 }, { x1, x2, y1, y2 }, sampleRate) {
  const first = -b1 * x1 - b2 * x2 + a1 * y1 + a2 * y2;
  const samples = [first, -b2 * x1 + a2 * y1 - a1 * first];
  const limit = Math.ceil(TRANSIENT_MAX_SECONDS * sampleRate);
  while (samples.length < limit) {
    const n = samples.length;
    const next = -a1 * samples[n - 1] - a2 * samples[n - 2];
    if (Math.abs(next) < TRANSIENT_FLOOR && Math.abs(samples[n - 1]) < TRANSIENT_FLOOR) break;
    samples.push(next);
  }
  return Float32Array.from(samples);
}

// A note that finds no earlier note still sounding through the shared volume
// gain resets it to the current volume. The slack covers the play loop's
// timers firing a little ahead of the audio clock they are compared with.
const VOLUME_QUIET_SLACK = 0.02; // seconds

// How long a volume gain retired by stopAll() outlives its fade (it leaves
// the graph once its last note has stopped).
const RETIRED_VOLUME_MARGIN_MS = 100;

/**
 * How many notes each frequency has among these pitches: a pitch listed
 * twice (two notes of a song) counts twice.
 * @param {Array<string|number>} pitches
 * @returns {Map<number, number>} frequency (Hz) -> notes
 */
function notesByFrequency(pitches) {
  const notes = new Map();
  pitches.forEach((pitch) => {
    const frequency = getFrequency(pitch);
    notes.set(frequency, (notes.get(frequency) || 0) + 1);
  });
  return notes;
}

/**
 * Random instrument with randomized timbre
 * Generates interesting, tonal sounds with consistent timbre
 */
class Random extends Instrument {
  constructor(id) {
    super(id);

    // Randomize timbre ONCE (stays constant for this instance)
    this.waveform = generateRandomWaveform();
    this.filterCutoff = generateRandomFilterCutoff();
    this.envelope = generateRandomEnvelope();
    this.harmonics = generateRandomHarmonics();

    // This timbre per pitch (see _voiceFor), and the never-connected copy of
    // its lowpass whose response shapes it
    this._voices = new Map(); // frequency (Hz) -> { wave, onset }
    this._lowpass = null;

    // Notes built ahead by prepare(), each for one later note at its pitch
    this._prepared = new Map(); // frequency (Hz) -> [{ oscillator, transient, envelopeGain }]

    // The volume gain every note plays through (see _volumeGainFor), and
    // one prepare() built for a note to find when none is live
    this._volume = null; // { node: GainNode, busyUntil: audio-clock seconds }
    this._spareVolume = null; // GainNode, unconnected
  }

  /**
   * Build these pitches' voices now (~1-1.5 ms each at 44.1-48 kHz, mostly
   * the browser's wavetable), so the first note of each costs no more than
   * any other. Synchronous. Above 88.2 kHz notes build no voices, so this
   * builds nothing.
   * @param {Array<string|number>} pitches - e.g. ['C/4', 'E/4']
   */
  warm(pitches) {
    if (this.disposed || !this._playsVoices()) return;
    pitches.forEach((pitch) => this._voiceFor(getFrequency(pitch)));
  }

  /**
   * Whether warm(pitches) has nothing left to build: each pitch's voice is
   * built already, or this instance builds none (disposed, or above
   * 88.2 kHz).
   * @param {Array<string|number>} pitches - e.g. ['C/4', 'E/4']
   * @returns {boolean}
   */
  isWarm(pitches) {
    if (this.disposed || !this._playsVoices()) return true;
    return pitches.every((pitch) => this._voices.has(getFrequency(pitch)));
  }

  /**
   * Build these notes' nodes now (an oscillator on the pitch's voice, the
   * onset buffer's source and the envelope gain, unstarted and unconnected;
   * ~0.1 ms a note, Chrome 152), and the volume gain if none is live, so the
   * notes that use them only schedule as they start: nothing built depends
   * on when a note starts. One note per entry (a pitch listed twice has two
   * ready), counting the notes already prepared; builds the voices too. The
   * next startNote() of each pitch takes one. stopAll() (pause, stop) and
   * dispose() let go of what is still unused. Synchronous. Above 88.2 kHz
   * notes build no voices, so this builds nothing.
   * @param {Array<string|number>} pitches - e.g. ['C/4', 'E/4', 'C/4']
   */
  prepare(pitches) {
    if (this.disposed || !this._playsVoices()) return;
    notesByFrequency(pitches).forEach((notes, frequency) => {
      const prepared = this._prepared.get(frequency) || [];
      while (prepared.length < notes) prepared.push(this._buildVoiceNote(frequency));
      this._prepared.set(frequency, prepared);
    });
    if (!this._volume && !this._spareVolume) this._spareVolume = this.context.createGain();
  }

  /**
   * Whether prepare(pitches) has nothing left to build: each entry's note
   * is prepared already, or this instance builds none (disposed, or above
   * 88.2 kHz).
   * @param {Array<string|number>} pitches - e.g. ['C/4', 'E/4', 'C/4']
   * @returns {boolean}
   */
  isPrepared(pitches) {
    if (this.disposed || !this._playsVoices()) return true;
    return [...notesByFrequency(pitches)].every(
      ([frequency, notes]) => (this._prepared.get(frequency) || []).length >= notes
    );
  }

  /**
   * Start a note: one oscillator on this timbre's voice for the pitch, or,
   * above 88.2 kHz, the graph that voice folds together.
   * Note cleans itself up after duration
   */
  startNote(pitch, duration) {
    if (this.disposed) return; // nothing it freed is built again
    const frequency = getFrequency(pitch);
    if (this._playsVoices()) this._startVoiceNote(frequency, duration);
    else this._startGraphNote(frequency, duration);
  }

  /** Whether notes play a voice (MAX_VOICE_TABLE_SIZE) at the context's rate. */
  _playsVoices() {
    return wavetableSize(this.context.sampleRate) <= MAX_VOICE_TABLE_SIZE;
  }

  /**
   * A note's envelope (ADSR) gain, joined to the volume gain every note
   * plays through.
   * @returns {{envelopeGain: GainNode, volumeGain: GainNode}}
   */
  _noteGains(currentTime, endTime, duration) {
    const volumeGain = this._volumeGainFor(currentTime, endTime);
    const envelopeGain = this.context.createGain();
    envelopeGain.connect(volumeGain);
    applyEnvelope(envelopeGain, currentTime, this.envelope, duration);
    return { envelopeGain, volumeGain };
  }

  /**
   * One oscillator playing this timbre's wavetable for the pitch, plus the
   * lowpass's onset transient, through the note's envelope and the
   * instrument's volume gain. Its nodes are the ones prepare() built for the
   * pitch if there are any left, else built now: everything that depends on
   * when the note starts (the connection into the graph, the envelope, the
   * frequency, start and stop) happens here either way.
   */
  _startVoiceNote(frequency, duration) {
    const { onset } = this._voiceFor(frequency);
    const { currentTime } = this.context;
    const endTime = currentTime + duration / 1000;
    const volumeGain = this._volumeGainFor(currentTime, endTime);
    const { oscillator, transient, envelopeGain } =
      this._takePrepared(frequency) || this._buildVoiceNote(frequency);

    envelopeGain.connect(volumeGain);
    applyEnvelope(envelopeGain, currentTime, this.envelope, duration);

    oscillator.frequency.setValueAtTime(frequency, currentTime);
    oscillator.connect(envelopeGain);
    oscillator.start(currentTime);
    oscillator.stop(endTime);

    // A few ms long: it plays out on its own (and is silent past the note,
    // where the envelope has closed). Its duration is spelled out because
    // Chrome 152 replays a buffer this short when it ends mid render
    // quantum (found nulling this graph, 2026-10-17).
    transient.connect(envelopeGain);
    transient.start(currentTime, 0, onset.duration);

    // Track it so pause/stop fade it and updateVolume reaches it. When it
    // ends only its envelope leaves the graph: the volume gain is shared.
    this.trackOscillator(oscillator, volumeGain, duration, undefined, envelopeGain);
  }

  /**
   * A voice note's nodes, unstarted and unconnected: the oscillator on the
   * pitch's wave, the source of its onset buffer, and its envelope gain.
   * @param {number} frequency - Hz
   * @returns {{oscillator: OscillatorNode, transient: AudioBufferSourceNode, envelopeGain: GainNode}}
   */
  _buildVoiceNote(frequency) {
    const { wave, onset } = this._voiceFor(frequency);
    const envelopeGain = this.context.createGain();
    const oscillator = this.context.createOscillator();
    oscillator.setPeriodicWave(wave);
    const transient = this.context.createBufferSource();
    transient.buffer = onset;
    return { oscillator, transient, envelopeGain };
  }

  /** A note prepare() built for this frequency, taken for one note; or none. */
  _takePrepared(frequency) {
    const prepared = this._prepared.get(frequency);
    if (!prepared) return undefined;
    const note = prepared.shift();
    if (prepared.length === 0) this._prepared.delete(frequency);
    return note;
  }

  /**
   * The graph a voice folds together, built for one note: the built-in wave
   * through the lowpass, plus a sine oscillator and gain per harmonic,
   * through the note's envelope and the instrument's volume gain: the graph
   * every voice is nulled against, so it sounds the same by construction.
   */
  _startGraphNote(frequency, duration) {
    const { currentTime } = this.context;
    const endTime = currentTime + duration / 1000;
    const { envelopeGain, volumeGain } = this._noteGains(currentTime, endTime, duration);

    const oscillator = this.context.createOscillator();
    oscillator.type = this.waveform;
    oscillator.frequency.setValueAtTime(frequency, currentTime);

    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(this.filterCutoff, currentTime);
    oscillator.connect(filter);
    filter.connect(envelopeGain);

    oscillator.start(currentTime);
    oscillator.stop(endTime);
    // Tracked as a voice's oscillator is. The note's oscillators all stop
    // together, so the first to end frees the envelope for all of them
    this.trackOscillator(oscillator, volumeGain, duration, undefined, envelopeGain);

    this.harmonics.forEach(({ multiple, volume }) => {
      const harmonic = this.context.createOscillator();
      harmonic.type = 'sine'; // Harmonics always sine
      harmonic.frequency.setValueAtTime(frequency * multiple, currentTime);

      const harmonicGain = this.context.createGain();
      harmonicGain.gain.setValueAtTime(volume, currentTime);
      harmonic.connect(harmonicGain);
      harmonicGain.connect(envelopeGain);

      harmonic.start(currentTime);
      harmonic.stop(endTime);
      this.trackOscillator(harmonic, volumeGain, duration, undefined, envelopeGain);
    });
  }

  /**
   * Fade every sounding note out on the shared volume gain (as each note's
   * own gain used to be faded), then retire that gain: the next note gets a
   * fresh one at the current volume, as it always did. What prepare() built
   * that no note has used is let go (never started or connected, nothing
   * else holds it).
   * @param {number} fadeTime - Fade out time in seconds (default 0.01)
   */
  stopAll(fadeTime = 0.01) {
    super.stopAll(fadeTime);
    this._prepared.clear();
    this._spareVolume = null;
    const retired = this._volume;
    if (!retired) return;
    this._volume = null;
    setTimeout(() => {
      try {
        retired.node.disconnect();
      } catch (e) {
        // Context may be torn down
      }
    }, fadeTime * 1000 + RETIRED_VOLUME_MARGIN_MS);
  }

  /**
   * Retire the instrument, freeing what it built to play: every voice (each
   * wave is ~0.6 MB of the browser's wavetables; see MAX_VOICE_TABLE_SIZE),
   * the lowpass probe, and what stop() frees: the notes prepared and unused,
   * and the volume gain, retired once its fade is over.
   */
  dispose() {
    super.dispose();
    this._voices.clear();
    this._lowpass = null;
  }

  /**
   * This timbre at one pitch, as one periodic wave plus an onset buffer.
   * The wave is the built-in wave as the lowpass shapes it in the steady
   * state (each partial scaled and phase-shifted by the filter's response
   * at its frequency) plus the sine harmonics, which bypass the filter; the
   * buffer is the transient the filter adds as it starts from rest. One
   * oscillator and that buffer sound like the oscillator -> lowpass and
   * harmonic oscillators they replace (null-tested in Chrome 2026-10-17, see
   * CHANGELOG). Built once per pitch, then cached.
   * @param {number} frequency - Hz
   * @returns {{wave: PeriodicWave, onset: AudioBuffer}}
   */
  _voiceFor(frequency) {
    const cached = this._voices.get(frequency);
    if (cached) return cached;

    const { sampleRate } = this.context;
    // Every partial up to Nyquist: the oscillator band-limits this wave for
    // the pitch exactly as it does a built-in one
    const count = Math.floor(sampleRate / 2 / frequency) + 1;
    const partialHz = new Float32Array(count);
    for (let k = 1; k < count; k += 1) partialHz[k] = k * frequency;
    const magnitude = new Float32Array(count).fill(1);
    const phase = new Float32Array(count);
    const lowpass = this._lowpassProbe();
    // Every Web Audio implementation has it; a test mock may not (it gets
    // the unfiltered wave, and makes no sound anyway)
    if (lowpass.getFrequencyResponse) lowpass.getFrequencyResponse(partialHz, magnitude, phase);

    const peak = builtinPeak(this.waveform, sampleRate);
    const real = new Float32Array(count); // cosine terms
    const imag = new Float32Array(count); // sine terms
    // The steady state one and two samples before the onset, as the filter
    // would have seen it (x) and as it would have come out (y)
    const before = { x1: 0, x2: 0, y1: 0, y2: 0 };
    for (let k = 1; k < count; k += 1) {
      const b = builtinCoefficient(this.waveform, k) / peak;
      // b·|H|·sin(ωt + φ) = b·|H|·(cos φ·sin ωt + sin φ·cos ωt)
      const shaped = b * magnitude[k];
      imag[k] = shaped * Math.cos(phase[k]);
      real[k] = shaped * Math.sin(phase[k]);
      const step = (2 * Math.PI * k * frequency) / sampleRate;
      before.x1 -= b * Math.sin(step);
      before.x2 -= b * Math.sin(2 * step);
      before.y1 += shaped * Math.sin(phase[k] - step);
      before.y2 += shaped * Math.sin(phase[k] - 2 * step);
    }
    this.harmonics.forEach(({ multiple, volume }) => {
      if (multiple < count) imag[multiple] += volume;
    });

    const transient = onsetTransient(
      lowpassCoefficients(this.filterCutoff, sampleRate),
      before,
      sampleRate
    );
    const onset = this.context.createBuffer(1, transient.length, sampleRate);
    onset.getChannelData(0).set(transient);

    const voice = {
      wave: this.context.createPeriodicWave(real, imag, { disableNormalization: true }),
      onset,
    };
    this._voices.set(frequency, voice);
    return voice;
  }

  /** The note lowpass, never connected: only its response is read. */
  _lowpassProbe() {
    if (!this._lowpass) {
      this._lowpass = this.context.createBiquadFilter();
      this._lowpass.type = 'lowpass';
      this._lowpass.frequency.value = this.filterCutoff;
    }
    return this._lowpass;
  }

  /**
   * The gain every note plays through, so updateVolume moves one AudioParam
   * however many notes sound. Each note used to get a gain of its own,
   * starting at exactly the current volume: a note that finds no earlier
   * note still sounding sets the shared one to it the same way, and one that
   * overlaps a sounding note joins the ramp that note is on. A fresh one is
   * the gain prepare() built if there is one, set and connected only now.
   * @param {number} startTime - the note's onset (audio clock, seconds)
   * @param {number} endTime - its end
   * @returns {GainNode}
   */
  _volumeGainFor(startTime, endTime) {
    if (!this._volume) {
      const node = this._spareVolume || this.context.createGain();
      this._spareVolume = null;
      node.gain.value = this.volumeMultiplier;
      node.connect(this.context.destination);
      this._volume = { node, busyUntil: endTime };
      return node;
    }
    const volume = this._volume;
    if (startTime + VOLUME_QUIET_SLACK >= volume.busyUntil) {
      volume.node.gain.setValueAtTime(this.volumeMultiplier, startTime);
    }
    volume.busyUntil = Math.max(volume.busyUntil, endTime);
    return volume.node;
  }
}

export default Random;
