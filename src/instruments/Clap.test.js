import audioContextManager from '../lib/AudioContextManager';
import Clap from './Clap';

function captureGraph() {
  const context = audioContextManager.getContext();
  const filters = [];
  const bufferSources = [];
  const origFilter = context.createBiquadFilter.bind(context);
  const origBufSrc = context.createBufferSource.bind(context);
  jest.spyOn(context, 'createBiquadFilter').mockImplementation(() => {
    const node = origFilter();
    filters.push(node);
    return node;
  });
  jest.spyOn(context, 'createBufferSource').mockImplementation(() => {
    const node = origBufSrc();
    bufferSources.push(node);
    return node;
  });
  return { filters, bufferSources };
}

describe('Clap instrument', () => {
  let graph;

  beforeEach(() => {
    graph = captureGraph();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('plays a noise-based clap with a highpass + two bandpass filter chain', async () => {
    const clap = new Clap();
    const playPromise = clap.play({
      data: [{ pitch: 'C/4', length: '1/16' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();

    // One noise source per clap.
    expect(graph.bufferSources).toHaveLength(1);
    expect(graph.bufferSources[0].start).toHaveBeenCalled();
    expect(graph.bufferSources[0].stop).toHaveBeenCalled();

    // Three filters: 1 highpass (500 Hz), 2 bandpass (1500 Hz, 3000 Hz).
    expect(graph.filters).toHaveLength(3);
    const types = graph.filters.map((f) => f.type).sort();
    expect(types).toEqual(['bandpass', 'bandpass', 'highpass']);

    const bandpassFreqs = graph.filters
      .filter((f) => f.type === 'bandpass')
      .map((f) => f.frequency.setValueAtTime.mock.calls[0][0])
      .sort((a, b) => a - b);
    expect(bandpassFreqs).toEqual([1500, 3000]);

    await jest.advanceTimersByTimeAsync(500);
    await playPromise;
  });

  it('ignores pitch — every clap sounds the same', async () => {
    const clap = new Clap();
    const a = clap.play({
      data: [{ pitch: 'C/4', length: '1/16' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();
    const filtersAfterFirst = graph.filters.length;
    await jest.advanceTimersByTimeAsync(500);
    await a;

    const b = clap.play({
      data: [{ pitch: 'B/5', length: '1/16' }],
      tempo: 120,
      basis: 4,
    });
    await Promise.resolve();
    // Second clap added the same number of filter nodes (3).
    expect(graph.filters.length).toBe(filtersAfterFirst + 3);
    await jest.advanceTimersByTimeAsync(500);
    await b;
  });

  it('clap() convenience method triggers a single clap immediately', () => {
    const clap = new Clap();
    clap.clap();
    expect(graph.bufferSources).toHaveLength(1);
    expect(graph.filters).toHaveLength(3);
  });
});
