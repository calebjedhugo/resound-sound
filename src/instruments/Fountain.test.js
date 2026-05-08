import audioContextManager from '../lib/AudioContextManager';
import Fountain from './Fountain';

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

describe('Fountain playback', () => {
  let graph;

  beforeEach(() => {
    graph = captureGraph();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds the bell-like timbre: 4 harmonics × 4 detune voices = 16 sine oscillators', async () => {
    const fountain = new Fountain();
    const playPromise = fountain.play({
      data: [{ pitch: 'A/4', length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();

    expect(graph.oscillators).toHaveLength(16);
    graph.oscillators.forEach((osc) => {
      expect(osc.type).toBe('sine');
    });

    // Frequencies: 440, 880, 1320, 2200 (1x, 2x, 3x, 5x — note: skips 4x).
    const uniqueFreqs = [
      ...new Set(
        graph.oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0])
      ),
    ].sort((a, b) => a - b);
    expect(uniqueFreqs).toEqual([440, 880, 1320, 2200]);

    await jest.advanceTimersByTimeAsync(500);
    await playPromise;
  });

  it('inserts a highpass filter at 200 Hz to scrub low rumble', async () => {
    const fountain = new Fountain();
    const playPromise = fountain.play({
      data: [{ pitch: 'A/4', length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();

    expect(graph.filters).toHaveLength(1);
    expect(graph.filters[0].type).toBe('highpass');
    expect(graph.filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      200,
      expect.any(Number)
    );

    await jest.advanceTimersByTimeAsync(500);
    await playPromise;
  });

  it('schedules every oscillator to stop at the note duration', async () => {
    const fountain = new Fountain();
    const playPromise = fountain.play({
      data: [{ pitch: 'A/4', length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();

    graph.oscillators.forEach((osc) => {
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
      const startTime = osc.start.mock.calls[0][0];
      const stopTime = osc.stop.mock.calls[0][0];
      expect(stopTime - startTime).toBeCloseTo(0.5, 5);
    });

    await jest.advanceTimersByTimeAsync(500);
    await playPromise;
  });
});
