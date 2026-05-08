import audioContextManager from '../lib/AudioContextManager';
import Random from './Random';

function captureGraph() {
  const context = audioContextManager.getContext();
  const oscillators = [];
  const filters = [];
  const origOsc = context.createOscillator.bind(context);
  const origFilter = context.createBiquadFilter.bind(context);
  jest.spyOn(context, 'createOscillator').mockImplementation(() => {
    const node = origOsc();
    jest.spyOn(node, 'start');
    jest.spyOn(node, 'stop');
    oscillators.push(node);
    return node;
  });
  jest.spyOn(context, 'createBiquadFilter').mockImplementation(() => {
    const node = origFilter();
    filters.push(node);
    return node;
  });
  return { oscillators, filters };
}

function snapshot(graph) {
  // Index 0 is the fundamental in Random.startNote; the rest are harmonics
  // whose frequency-ratio set is the locked-at-construction timbre under test.
  return {
    oscCount: graph.oscillators.length,
    waveforms: graph.oscillators.map((o) => o.type),
    fundamentalFreq: graph.oscillators[0].frequency.setValueAtTime.mock.calls[0][0],
    harmonicFreqs: graph.oscillators
      .slice(1)
      .map((o) => o.frequency.setValueAtTime.mock.calls[0][0]),
    filterCutoffs: graph.filters.map(
      (f) => f.frequency.setValueAtTime.mock.calls[0][0]
    ),
  };
}

describe('Random instrument', () => {
  let randomSpy;
  let graph;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    graph = captureGraph();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('locks its timbre at construction — flipping Math.random afterward does not change the played graph', async () => {
    const inst = new Random('r1');

    // First note: capture the graph the constructor's seed produced.
    let p = inst.play({
      data: [{ pitch: 'A/4', length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();
    const first = snapshot(graph);
    await jest.advanceTimersByTimeAsync(500);
    await p;

    // Reset capture buffers, then flip Math.random hard. If startNote re-rolls
    // any of {waveform, filter cutoff, harmonic count}, the snapshot will differ.
    graph.oscillators.length = 0;
    graph.filters.length = 0;
    randomSpy.mockReturnValue(0.99);

    p = inst.play({
      data: [{ pitch: 'A/4', length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();
    const second = snapshot(graph);

    expect(second.oscCount).toBe(first.oscCount);
    expect(second.waveforms).toEqual(first.waveforms);
    expect(second.fundamentalFreq).toBe(first.fundamentalFreq);
    expect(second.harmonicFreqs).toEqual(first.harmonicFreqs);
    expect(second.filterCutoffs).toEqual(first.filterCutoffs);

    await jest.advanceTimersByTimeAsync(500);
    await p;
  });

  it('builds a graph of one fundamental + N sine harmonics, each scheduled to stop with the note', async () => {
    const inst = new Random('r1');
    const playPromise = inst.play({
      data: [{ pitch: 'C/4', length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();

    // Fundamental is index 0; harmonics follow. With Math.random=0,
    // generateRandomHarmonics produces exactly 1 harmonic.
    expect(graph.oscillators.length).toBeGreaterThanOrEqual(2);
    graph.oscillators.slice(1).forEach((osc) => {
      expect(osc.type).toBe('sine');
    });

    // Every oscillator scheduled to stop after the quarter-note duration.
    graph.oscillators.forEach((osc) => {
      const startTime = osc.start.mock.calls[0][0];
      const stopTime = osc.stop.mock.calls[0][0];
      expect(stopTime - startTime).toBeCloseTo(0.5, 5);
    });

    await jest.advanceTimersByTimeAsync(500);
    await playPromise;
  });
});
