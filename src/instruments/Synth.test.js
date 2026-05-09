import audioContextManager from '../lib/AudioContextManager';
import Synth from './Synth';

// Snapshot Web Audio graph creation against the singleton context.
// Mirrors the helper in Piano.test.js — Synth shares the same runtime topology
// (oscillators → filter → envelope gain → volume gain → destination), so the
// same capture pattern applies.
function captureGraph() {
  const context = audioContextManager.getContext();
  const oscillators = [];
  const gains = [];
  const filters = [];

  const origOsc = context.createOscillator.bind(context);
  const origGain = context.createGain.bind(context);
  const origFilter = context.createBiquadFilter.bind(context);

  jest.spyOn(context, 'createOscillator').mockImplementation(() => {
    const node = origOsc();
    jest.spyOn(node, 'connect');
    jest.spyOn(node, 'start');
    jest.spyOn(node, 'stop');
    oscillators.push(node);
    return node;
  });
  jest.spyOn(context, 'createGain').mockImplementation(() => {
    const node = origGain();
    jest.spyOn(node, 'connect');
    gains.push(node);
    return node;
  });
  jest.spyOn(context, 'createBiquadFilter').mockImplementation(() => {
    const node = origFilter();
    jest.spyOn(node, 'connect');
    filters.push(node);
    return node;
  });

  return { context, oscillators, gains, filters };
}

const QUARTER_AT_120 = 500; // ms

describe('Synth playback', () => {
  let graph;

  beforeEach(() => {
    graph = captureGraph();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('default configuration', () => {
    it('produces a single sine oscillator on the fundamental, routed through a default lowpass filter at 5 kHz', async () => {
      const synth = new Synth();
      const playPromise = synth.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // Default detune = [0], no harmonics → exactly 1 oscillator.
      expect(graph.oscillators).toHaveLength(1);
      const osc = graph.oscillators[0];
      expect(osc.type).toBe('sine');
      expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, expect.any(Number));
      expect(osc.detune.setValueAtTime).toHaveBeenCalledWith(0, expect.any(Number));

      // Exactly one filter, default lowpass @ 5000 Hz.
      expect(graph.filters).toHaveLength(1);
      expect(graph.filters[0].type).toBe('lowpass');
      expect(graph.filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(
        5000,
        expect.any(Number)
      );

      // Gain routing: oscillator → filter → envelopeGain → volumeGain → destination.
      // Two gains in default config (no harmonics): volumeGain, envelopeGain.
      expect(graph.gains).toHaveLength(2);
      const [volumeGain, envelopeGain] = graph.gains;
      expect(volumeGain.connect).toHaveBeenCalledWith(graph.context.destination);
      expect(envelopeGain.connect).toHaveBeenCalledWith(volumeGain);
      expect(graph.filters[0].connect).toHaveBeenCalledWith(envelopeGain);
      expect(osc.connect).toHaveBeenCalledWith(graph.filters[0]);

      // Oscillator started and scheduled to stop after the note duration.
      const startTime = osc.start.mock.calls[0][0];
      const stopTime = osc.stop.mock.calls[0][0];
      expect(stopTime - startTime).toBeCloseTo(QUARTER_AT_120 / 1000, 5);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('schedules the default ADSR envelope: silent → attack peak → decay → sustain hold → release', async () => {
      const synth = new Synth();
      const playPromise = synth.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // Identify envelopeGain by its ramp to attack peak (1.0).
      const envelopeGain = graph.gains.find(
        (g) => g.gain.linearRampToValueAtTime.mock.calls[0]?.[0] === 1.0
      );
      expect(envelopeGain).toBeDefined();

      const setCalls = envelopeGain.gain.setValueAtTime.mock.calls;
      const rampCalls = envelopeGain.gain.linearRampToValueAtTime.mock.calls;

      // Default sustain = 0.5.
      // Schedule: setValueAtTime(0), ramp→1, ramp→0.5, setValueAtTime(0.5), ramp→0
      expect(setCalls).toHaveLength(2);
      expect(rampCalls).toHaveLength(3);

      expect(setCalls[0][0]).toBe(0); // 1. silent at t0
      expect(rampCalls[0][0]).toBe(1.0); // 2. attack peak
      expect(rampCalls[1][0]).toBeCloseTo(0.5, 5); // 3. decay to sustain
      expect(setCalls[1][0]).toBeCloseTo(0.5, 5); // 4. hold sustain
      expect(rampCalls[2][0]).toBe(0); // 5. release to silence

      // Times must be monotonically non-decreasing in order.
      const sequence = [
        setCalls[0][1],
        rampCalls[0][1],
        rampCalls[1][1],
        setCalls[1][1],
        rampCalls[2][1],
      ];
      for (let i = 1; i < sequence.length; i += 1) {
        expect(sequence[i]).toBeGreaterThanOrEqual(sequence[i - 1]);
      }

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('overrides', () => {
    it('detune override produces one oscillator per cents value, all on the fundamental', async () => {
      const synth = new Synth();
      synth.detune = [-10, 0, 10];

      const playPromise = synth.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 3 detune entries → 3 oscillators, all sine, all at 440 Hz.
      expect(graph.oscillators).toHaveLength(3);
      graph.oscillators.forEach((osc) => {
        expect(osc.type).toBe('sine');
        expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, expect.any(Number));
      });

      const detuneValues = graph.oscillators
        .map((o) => o.detune.setValueAtTime.mock.calls[0][0])
        .sort((a, b) => a - b);
      expect(detuneValues).toEqual([-10, 0, 10]);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('harmonics override adds sine oscillators at integer multiples through their own gain nodes', async () => {
      const synth = new Synth();
      synth.harmonics = [
        { multiple: 2, volume: 0.3 },
        { multiple: 3, volume: 0.2 },
      ];

      const playPromise = synth.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 1 fundamental + 2 harmonics = 3 oscillators total.
      expect(graph.oscillators).toHaveLength(3);

      // Harmonics are always sine, regardless of waveform.
      const sines = graph.oscillators.filter((o) => o.type === 'sine');
      expect(sines).toHaveLength(3); // fundamental is sine too in default config

      // Identify harmonic oscillators by their (non-fundamental) frequency.
      const harmonicFreqs = graph.oscillators
        .map((o) => o.frequency.setValueAtTime.mock.calls[0][0])
        .filter((f) => f !== 440)
        .sort((a, b) => a - b);
      expect(harmonicFreqs).toEqual([880, 1320]); // 2× and 3× of 440

      // 2 volume + 2 envelope... no — 1 volumeGain + 1 envelopeGain + 2 harmonic gains = 4.
      expect(graph.gains).toHaveLength(4);

      // Harmonic gains are connected to the filter and carry the configured volume values.
      const harmonicGains = graph.gains.filter((g) =>
        g.connect.mock.calls.some((call) => call[0] === graph.filters[0])
      );
      expect(harmonicGains).toHaveLength(2);

      const harmonicVolumes = harmonicGains
        .map((g) => g.gain.setValueAtTime.mock.calls[0][0])
        .sort((a, b) => b - a);
      expect(harmonicVolumes).toEqual([0.3, 0.2]);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('waveform override applies to detune oscillators but harmonics stay sine', async () => {
      const synth = new Synth();
      synth.waveform = 'sawtooth';
      synth.detune = [-5, 5];
      synth.harmonics = [{ multiple: 2, volume: 0.25 }];

      const playPromise = synth.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 2 detune + 1 harmonic = 3 oscillators
      expect(graph.oscillators).toHaveLength(3);

      const sawtooths = graph.oscillators.filter((o) => o.type === 'sawtooth');
      const sines = graph.oscillators.filter((o) => o.type === 'sine');
      expect(sawtooths).toHaveLength(2);
      expect(sines).toHaveLength(1);

      // The sine harmonic is at 2× the fundamental.
      expect(sines[0].frequency.setValueAtTime).toHaveBeenCalledWith(880, expect.any(Number));

      // The sawtooth oscillators sit on the fundamental.
      sawtooths.forEach((osc) => {
        expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, expect.any(Number));
      });

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('filterType and filterCutoff overrides reshape the filter', async () => {
      const synth = new Synth();
      synth.filterType = 'highpass';
      synth.filterCutoff = 800;

      const playPromise = synth.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      expect(graph.filters).toHaveLength(1);
      expect(graph.filters[0].type).toBe('highpass');
      expect(graph.filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(
        800,
        expect.any(Number)
      );

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('subclass smoke test', () => {
    it('a subclass overriding multiple defaults produces a graph that reflects all of them', async () => {
      // Mirrors the editor-generated subclass shape: a class extending Synth
      // that swaps several defaults at once in its constructor.
      class CustomBell extends Synth {
        constructor() {
          super('custom-bell');
          this.envelope = { attack: 0.005, decay: 0.2, sustain: 0.4, release: 0.3 };
          this.harmonics = [
            { multiple: 2, volume: 0.4 },
            { multiple: 4, volume: 0.2 },
          ];
          this.detune = [-12, 12];
          this.waveform = 'triangle';
          this.filterType = 'bandpass';
          this.filterCutoff = 1500;
        }
      }

      const bell = new CustomBell();
      const playPromise = bell.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 2 detuned triangles + 2 sine harmonics = 4 oscillators.
      expect(graph.oscillators).toHaveLength(4);
      const triangles = graph.oscillators.filter((o) => o.type === 'triangle');
      const sines = graph.oscillators.filter((o) => o.type === 'sine');
      expect(triangles).toHaveLength(2);
      expect(sines).toHaveLength(2);

      // Triangles sit on 440; sine harmonics on 880 and 1760.
      triangles.forEach((osc) => {
        expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, expect.any(Number));
      });
      const harmonicFreqs = sines
        .map((o) => o.frequency.setValueAtTime.mock.calls[0][0])
        .sort((a, b) => a - b);
      expect(harmonicFreqs).toEqual([880, 1760]);

      // Detune values are applied to triangles.
      const detuneValues = triangles
        .map((o) => o.detune.setValueAtTime.mock.calls[0][0])
        .sort((a, b) => a - b);
      expect(detuneValues).toEqual([-12, 12]);

      // Filter is bandpass at 1500 Hz.
      expect(graph.filters).toHaveLength(1);
      expect(graph.filters[0].type).toBe('bandpass');
      expect(graph.filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(
        1500,
        expect.any(Number)
      );

      // Envelope gain reflects the custom sustain (0.4).
      const envelopeGain = graph.gains.find(
        (g) => g.gain.linearRampToValueAtTime.mock.calls[0]?.[0] === 1.0
      );
      expect(envelopeGain).toBeDefined();
      const rampCalls = envelopeGain.gain.linearRampToValueAtTime.mock.calls;
      expect(rampCalls[1][0]).toBeCloseTo(0.4, 5);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });
});
