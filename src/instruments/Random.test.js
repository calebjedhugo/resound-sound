import audioContextManager from '../lib/AudioContextManager';
import Random from './Random';

function captureGraph() {
  const context = audioContextManager.getContext();
  const oscillators = [];
  const gains = [];
  const waves = [];
  const sources = [];
  const filters = [];
  const origOsc = context.createOscillator.bind(context);
  const origGain = context.createGain.bind(context);
  const origWave = context.createPeriodicWave.bind(context);
  const origSource = context.createBufferSource.bind(context);
  const origFilter = context.createBiquadFilter.bind(context);
  jest.spyOn(context, 'createBiquadFilter').mockImplementation(() => {
    const node = origFilter();
    jest.spyOn(node, 'connect');
    filters.push(node);
    return node;
  });
  jest.spyOn(context, 'createBufferSource').mockImplementation(() => {
    const node = origSource();
    sources.push(node);
    return node;
  });
  jest.spyOn(context, 'createOscillator').mockImplementation(() => {
    const node = origOsc();
    jest.spyOn(node, 'connect');
    jest.spyOn(node, 'start');
    jest.spyOn(node, 'stop');
    jest.spyOn(node, 'setPeriodicWave');
    oscillators.push(node);
    return node;
  });
  jest.spyOn(context, 'createGain').mockImplementation(() => {
    const node = origGain();
    jest.spyOn(node, 'connect');
    jest.spyOn(node, 'disconnect');
    gains.push(node);
    return node;
  });
  jest.spyOn(context, 'createPeriodicWave').mockImplementation((real, imag, options) => {
    const wave = origWave(real, imag, options);
    waves.push({ wave, real: Array.from(real), imag: Array.from(imag), options });
    return wave;
  });
  return { context, oscillators, gains, waves, sources, filters };
}

// Every object reachable from a root through own properties, Map and Set
// entries: what a garbage collector would keep alive for a live instance
// (the AudioContext is shared, not the instance's)
function reachableFrom(root, context) {
  const seen = new Set();
  const visit = (value) => {
    if (value === null || typeof value !== 'object' || value === context || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) value.forEach((entry, key) => [key, entry].forEach(visit));
    if (value instanceof Set) value.forEach(visit);
    if (!ArrayBuffer.isView(value)) Object.values(value).forEach(visit);
  };
  visit(root);
  return seen;
}

const QUARTER_AT_120 = 500; // ms
const A4 = [{ pitch: 'A/4', length: '1/4' }];
const SAMPLE_RATE = 44100; // the mock context's

// Chrome renders a built-in square at 1/1.1789798 of its Fourier series (the
// Gibbs peak of its 4096-sample table): measured 2026-10-17 by nulling a
// built-in oscillator against a wave built from the series, residual -140 dB.
const SQUARE_TABLE_PEAK = 1.1789798;
const squarePartial = (k) => (k % 2 ? 4 / (Math.PI * k) / SQUARE_TABLE_PEAK : 0);

// The lowpass's response at a frequency, from the (mock) browser filter
function lowpassResponse(cutoff, frequency) {
  const filter = audioContextManager.getContext().createBiquadFilter();
  filter.frequency.value = cutoff;
  const magnitude = new Float32Array(1);
  const phase = new Float32Array(1);
  filter.getFrequencyResponse(new Float32Array([frequency]), magnitude, phase);
  return { magnitude: magnitude[0], phase: phase[0] };
}

// The spec's lowpass biquad (Q = 1 dB), normalized to a0 = 1
function specLowpass(cutoff) {
  const theta = (2 * Math.PI * cutoff) / SAMPLE_RATE;
  const alpha = Math.sin(theta) / (2 * 10 ** (1 / 20));
  const cos = Math.cos(theta);
  const a0 = 1 + alpha;
  const b = (1 - cos) / 2 / a0;
  return { b0: b, b1: 2 * b, b2: b, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

async function playAndFinish(inst, data) {
  const playPromise = inst.play({ data, tempo: 120, basis: 4 });
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
  await playPromise;
}

describe('Random instrument', () => {
  let randomSpy;
  let graph;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    graph = captureGraph();
  });

  afterEach(() => {
    graph.context.currentTime = 0;
    graph.context.sampleRate = SAMPLE_RATE;
    jest.restoreAllMocks();
  });

  it('locks its timbre at construction — flipping Math.random afterward does not change the played wave', async () => {
    const inst = new Random('r1');
    randomSpy.mockReturnValue(0.99);
    await playAndFinish(inst, [{ pitch: 'B/4', length: '1/4' }]);

    // A twin built from the same seed plays the same pitch: if startNote
    // re-rolled any of {waveform, cutoff, harmonics}, the waves would differ
    randomSpy.mockReturnValue(0);
    const twin = new Random('r2');
    await playAndFinish(twin, [{ pitch: 'B/4', length: '1/4' }]);

    expect(graph.waves).toHaveLength(2);
    expect(graph.waves[0].real).toEqual(graph.waves[1].real);
    expect(graph.waves[0].imag).toEqual(graph.waves[1].imag);
  });

  it('plays each note as ONE oscillator on the pitch, scheduled to stop with the note', async () => {
    const inst = new Random('r1');
    const playPromise = inst.play({ data: [{ pitch: 'C/4', length: '1/4' }], tempo: 120, basis: 4 });
    await Promise.resolve();

    expect(graph.oscillators).toHaveLength(1);
    const [osc] = graph.oscillators;
    expect(osc.setPeriodicWave).toHaveBeenCalledWith(graph.waves[0].wave);
    expect(osc.frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(261.63, 1);
    expect(osc.stop.mock.calls[0][0] - osc.start.mock.calls[0][0]).toBeCloseTo(0.5, 5);

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
  });

  it("folds the lowpass's response at each partial, and the unfiltered harmonics, into the wave", async () => {
    // Math.random = 0: a sine, cutoff 500 Hz, one harmonic (2x at 0.1)
    const inst = new Random('r1');
    await playAndFinish(inst, A4);

    const { real, imag, options } = graph.waves[0];
    // Every partial up to Nyquist
    expect(imag).toHaveLength(Math.floor(SAMPLE_RATE / 2 / 440) + 1);
    // Normalization off: the coefficients ARE the amplitudes
    expect(options).toEqual({ disableNormalization: true });

    // The fundamental, scaled and phase-shifted by the filter at 440 Hz:
    // sin(wt + phi) = cos(phi) sin(wt) + sin(phi) cos(wt)
    const { magnitude, phase } = lowpassResponse(500, 440);
    expect(imag[1]).toBeCloseTo(magnitude * Math.cos(phase), 6);
    expect(real[1]).toBeCloseTo(magnitude * Math.sin(phase), 6);
    // The harmonic bypasses the filter, as its own oscillator did
    expect(imag[2]).toBeCloseTo(0.1, 6);
    expect(real[2]).toBeCloseTo(0, 10);
    expect(imag.slice(3).every((b) => b === 0)).toBe(true);
  });

  it('matches the built-in square: its series divided by the full-band table peak', async () => {
    randomSpy.mockReturnValue(0.9); // the square, cutoff 4550 Hz
    const inst = new Random('r1');
    expect(inst.waveform).toBe('square');
    await playAndFinish(inst, A4);

    const { imag } = graph.waves[0];
    const filterAt = (k) => {
      const { magnitude, phase } = lowpassResponse(inst.filterCutoff, 440 * k);
      return magnitude * Math.cos(phase);
    };
    expect(imag[1] / filterAt(1)).toBeCloseTo(squarePartial(1), 6);
    expect(imag[5] / filterAt(5)).toBeCloseTo(squarePartial(5), 6);
  });

  it('plays the lowpass start-up transient with the wave: together they ARE the filter started from rest', async () => {
    // A square through a low cutoff (725 Hz) rings longest; harmonics 2x/3x
    randomSpy.mockReturnValueOnce(0.9).mockReturnValueOnce(0.05).mockReturnValue(0.5);
    const inst = new Random('r1');
    expect(inst.filterCutoff).toBeCloseTo(725, 6);
    await playAndFinish(inst, A4);

    const [source] = graph.sources;
    expect(source.connect).toHaveBeenCalledWith(graph.gains[1]); // the note's envelope
    const onset = source.buffer.getChannelData(0);
    expect(onset.length).toBeGreaterThan(100); // ~ms at 725 Hz, then done
    // With the oscillator, exactly once (Chrome replays an unbounded short
    // buffer that ends mid render quantum)
    expect(source.start).toHaveBeenCalledWith(0, 0, onset.length / SAMPLE_RATE);

    // The old graph: the built-in square through the lowpass, from rest
    const { real, imag } = graph.waves[0];
    const step = (k) => (2 * Math.PI * k * 440) / SAMPLE_RATE;
    const square = (n) => imag.reduce((sum, _, k) => sum + squarePartial(k) * Math.sin(step(k) * n), 0);
    const { b0, b1, b2, a1, a2 } = specLowpass(inst.filterCutoff);
    const fromRest = [];
    for (let n = 0; n < onset.length + 50; n += 1) {
      const y = b0 * square(n) + b1 * (n > 0 ? square(n - 1) : 0) + b2 * (n > 1 ? square(n - 2) : 0)
        - a1 * (fromRest[n - 1] || 0) - a2 * (fromRest[n - 2] || 0);
      fromRest.push(y);
    }
    // The wave's filtered part (the harmonics bypass the filter)
    const harmonic = new Map(inst.harmonics.map(({ multiple, volume }) => [multiple, volume]));
    const steady = (n) => imag.reduce(
      (sum, b, k) => sum + real[k] * Math.cos(step(k) * n) + (b - (harmonic.get(k) || 0)) * Math.sin(step(k) * n),
      0
    );

    fromRest.forEach((y, n) => {
      expect(steady(n) + (n < onset.length ? onset[n] : 0)).toBeCloseTo(y, 5);
    });
  });

  it('builds each pitch once, and warm() builds it before the first note', async () => {
    const inst = new Random('r1');
    inst.warm(['A/4']);
    expect(graph.waves).toHaveLength(1);

    await playAndFinish(inst, A4);
    await playAndFinish(inst, A4);
    expect(graph.waves).toHaveLength(1);
    expect(graph.oscillators[1].setPeriodicWave).toHaveBeenCalledWith(graph.waves[0].wave);
    expect(graph.sources[1].buffer).toBe(graph.sources[0].buffer);

    await playAndFinish(inst, [{ pitch: 'C/5', length: '1/4' }]);
    expect(graph.waves).toHaveLength(2);
  });

  it('is warm for a pitch once its voice is built, by warm() or by a first note', async () => {
    const inst = new Random('r1');
    expect(inst.isWarm(['A/4'])).toBe(false);

    inst.warm(['A/4']);
    expect(inst.isWarm(['A/4'])).toBe(true);
    expect(inst.isWarm(['A/4', 'C/5'])).toBe(false);

    await playAndFinish(inst, [{ pitch: 'C/5', length: '1/4' }]);
    expect(inst.isWarm(['A/4', 'C/5'])).toBe(true);
  });

  it('plays one oscillator on a voice up to 88.2 kHz', async () => {
    graph.context.sampleRate = 88200;
    const inst = new Random('r1');
    await playAndFinish(inst, A4);

    expect(graph.oscillators).toHaveLength(1);
    expect(graph.oscillators[0].setPeriodicWave).toHaveBeenCalledWith(graph.waves[0].wave);
  });

  describe('above 88.2 kHz, where a voice would hold 16384-sample wavetables', () => {
    beforeEach(() => {
      graph.context.sampleRate = 96000;
    });

    it('plays the graph a voice folds together: the built-in wave through the lowpass, plus a sine per harmonic', async () => {
      randomSpy.mockReturnValue(0.5); // a triangle, cutoff 2750 Hz, harmonics 2x and 3x at 0.2
      const inst = new Random('r1');
      const playPromise = inst.play({ data: A4, tempo: 120, basis: 4 });
      await Promise.resolve();

      expect(graph.waves).toHaveLength(0);
      expect(graph.sources).toHaveLength(0);
      const [volumeGain, envelope, ...harmonicGains] = graph.gains;
      expect(volumeGain.connect).toHaveBeenCalledWith(graph.context.destination);
      expect(envelope.connect).toHaveBeenCalledWith(volumeGain);

      const [fundamental, ...harmonics] = graph.oscillators;
      const [lowpass] = graph.filters;
      expect(fundamental.type).toBe('triangle');
      expect(fundamental.frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(440, 6);
      expect(fundamental.connect).toHaveBeenCalledWith(lowpass);
      expect(lowpass.type).toBe('lowpass');
      expect(lowpass.frequency.setValueAtTime).toHaveBeenCalledWith(inst.filterCutoff, 0);
      expect(lowpass.connect).toHaveBeenCalledWith(envelope);

      expect(harmonics.map((osc) => osc.type)).toEqual(['sine', 'sine']);
      harmonics.forEach((osc, i) => {
        const { multiple, volume } = inst.harmonics[i];
        expect(osc.frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(440 * multiple, 6);
        expect(osc.connect).toHaveBeenCalledWith(harmonicGains[i]);
        expect(harmonicGains[i].gain.setValueAtTime).toHaveBeenCalledWith(volume, 0);
        expect(harmonicGains[i].connect).toHaveBeenCalledWith(envelope);
      });
      graph.oscillators.forEach((osc) => {
        expect(osc.stop.mock.calls[0][0] - osc.start.mock.calls[0][0]).toBeCloseTo(0.5, 5);
      });

      // One volume gain for all of it, which a volume change ramps once
      inst.updateVolume(0.5);
      expect(volumeGain.gain.setTargetAtTime).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('builds no voices, so warm() has nothing to do and every pitch is warm', async () => {
      const inst = new Random('r1');
      inst.warm(['A/4', 'C/5']);
      await playAndFinish(inst, A4);

      expect(graph.waves).toHaveLength(0);
      expect(inst.isWarm(['A/4', 'C/5'])).toBe(true);
    });
  });

  it('routes every note through one volume gain that a volume change ramps once', async () => {
    const inst = new Random('r1');
    const playPromise = inst.play({
      data: [[{ pitch: 'C/4', length: '1/4' }, { pitch: 'E/4', length: '1/4' }, { pitch: 'G/4', length: '1/4' }]],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();

    // One volume gain, then one envelope per note
    expect(graph.gains).toHaveLength(4);
    const [volumeGain, ...envelopes] = graph.gains;
    expect(volumeGain.connect).toHaveBeenCalledWith(graph.context.destination);
    envelopes.forEach((envelope) => expect(envelope.connect).toHaveBeenCalledWith(volumeGain));

    inst.updateVolume(0.5);
    expect(volumeGain.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
    expect(volumeGain.gain.setTargetAtTime).toHaveBeenCalledWith(0.5, 0, 0.01);
    envelopes.forEach((envelope) => expect(envelope.gain.setTargetAtTime).not.toHaveBeenCalled());

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
  });

  it('starts a note at exactly the current volume once the earlier notes are over', async () => {
    // As a note's own gain did: no inheriting the tail of an old ramp
    const inst = new Random('r1');
    await playAndFinish(inst, A4);
    const volumeGain = graph.gains[0];
    graph.context.currentTime = 2; // well past the first note's end
    inst.updateVolume(0.3);

    const playPromise = inst.play({ data: A4, tempo: 120, basis: 4 });
    await Promise.resolve();
    expect(volumeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.3, 2);

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
  });

  it('counts the next note of a phrase as starting after the last, though its timer runs ahead of the audio clock', async () => {
    const inst = new Random('r1');
    const playPromise = inst.play({ data: A4, tempo: 120, basis: 4 });
    await Promise.resolve();
    const volumeGain = graph.gains[0];
    inst.updateVolume(0.3);

    // The play loop wakes on a timer; the audio clock it reads can still be
    // a few ms short of the previous note's end
    graph.context.currentTime = 0.49;
    inst.startNote('B/4', 500);
    expect(volumeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.3, 0.49);

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
  });

  it('leaves a sounding note on its ramp when another note joins it', async () => {
    const inst = new Random('r1');
    const first = inst.play({ data: [{ pitch: 'A/4', length: '1/1' }], tempo: 120, basis: 4 });
    await Promise.resolve();
    const volumeGain = graph.gains[0];

    // A second, overlapping voice on the same instrument
    graph.context.currentTime = 0.5;
    inst.startNote('C/5', 500);
    expect(volumeGain.gain.setValueAtTime).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 4);
    await first;
  });

  it('frees only the note’s own envelope when it ends; the volume gain stays for the next note', async () => {
    const inst = new Random('r1');
    const playPromise = inst.play({ data: A4, tempo: 120, basis: 4 });
    await Promise.resolve();
    const [volumeGain, envelope] = graph.gains;

    graph.oscillators[0].onended();
    expect(envelope.disconnect).toHaveBeenCalled();
    expect(volumeGain.disconnect).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
  });

  it('fades sounding notes on the volume gain when stopped, and plays later notes on a fresh one', async () => {
    const inst = new Random('r1');
    inst.updateVolume(0.6);
    const playPromise = inst.play({ data: A4, tempo: 120, basis: 4 });
    await Promise.resolve();
    const [volumeGain, envelope] = graph.gains;

    inst.stop();

    // The fade rides the volume gain; the envelope keeps its shape under it
    expect(volumeGain.gain.cancelScheduledValues).toHaveBeenCalled();
    expect(volumeGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.05);
    expect(graph.oscillators[0].stop).toHaveBeenLastCalledWith(0.05);
    expect(envelope.gain.cancelScheduledValues).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
    // Retired: it leaves the graph once the fade is over
    expect(volumeGain.disconnect).toHaveBeenCalled();

    await playAndFinish(inst, A4);
    const freshGain = graph.gains[2];
    expect(freshGain).not.toBe(volumeGain);
    expect(freshGain.gain.value).toBe(0.6);
    expect(freshGain.connect).toHaveBeenCalledWith(graph.context.destination);
  });

  it('lets go of its voices, lowpass probe and volume gain when disposed', async () => {
    const inst = new Random('r1');
    inst.warm(['A/4', 'C/5']);
    const playPromise = inst.play({ data: A4, tempo: 120, basis: 4 });
    await Promise.resolve();
    const built = [
      ...graph.waves.map(({ wave }) => wave),
      ...graph.sources.map((source) => source.buffer), // the onsets
      ...graph.filters, // the probe
      graph.gains[0], // the volume gain
    ];
    expect(built).toHaveLength(2 + 1 + 1 + 1);
    // (A broken walk would pass the check below: it does reach them now)
    const reachable = reachableFrom(inst, graph.context);
    built.forEach((node) => expect(reachable.has(node)).toBe(true));

    inst.dispose();

    const left = reachableFrom(inst, graph.context);
    built.forEach((node) => expect(left.has(node)).toBe(false));
    // The sounding note fades on the volume gain, which then leaves the graph
    const [volumeGain] = graph.gains;
    expect(volumeGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.05);
    await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
    await playPromise;
    expect(volumeGain.disconnect).toHaveBeenCalled();
  });

  it('builds nothing again once disposed, whatever asks', async () => {
    const inst = new Random('r1');
    await playAndFinish(inst, A4);
    inst.dispose();
    const counts = () => [graph.waves, graph.sources, graph.oscillators, graph.gains, graph.filters]
      .map((nodes) => nodes.length);
    const before = counts();

    inst.warm(['C/5']); // a prewarm job still queued for it
    inst.startNote('C/5', 500); // a scheduler driving it directly
    await playAndFinish(inst, A4);

    expect(counts()).toEqual(before);
    expect(inst.isWarm(['C/5'])).toBe(true); // nothing left for a warm() to build
  });
});
