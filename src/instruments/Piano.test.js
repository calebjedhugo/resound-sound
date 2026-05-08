import audioContextManager from 'audio/lib/AudioContextManager';
import Piano from 'audio/instruments/Piano';

// Snapshot Web Audio graph creation against the singleton context.
// Using the context this way (not a fresh per-test instance) mirrors the
// shipped runtime: the package will continue to expose a singleton.
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

describe('Piano playback', () => {
  let graph;

  beforeEach(() => {
    graph = captureGraph();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a single note', () => {
    it('schedules every oscillator the Piano timbre requires', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });

      // Note is dispatched synchronously at index 0; let microtasks settle.
      await Promise.resolve();

      // Piano timbre: 3 detuned triangle oscillators (chorus) + 4 sine harmonics.
      expect(graph.oscillators).toHaveLength(7);

      const triangles = graph.oscillators.filter((o) => o.type === 'triangle');
      const sines = graph.oscillators.filter((o) => o.type === 'sine');
      expect(triangles).toHaveLength(3);
      expect(sines).toHaveLength(4);

      // All chorus oscillators sit on the fundamental (440 Hz).
      triangles.forEach((osc) => {
        expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, expect.any(Number));
      });

      // Harmonics are at 2x, 3x, 4x, 5x the fundamental.
      const harmonicFreqs = sines
        .map((osc) => osc.frequency.setValueAtTime.mock.calls[0][0])
        .sort((a, b) => a - b);
      expect(harmonicFreqs).toEqual([880, 1320, 1760, 2200]);

      // Every oscillator is started and scheduled to stop after the note duration.
      graph.oscillators.forEach((osc) => {
        expect(osc.start).toHaveBeenCalled();
        expect(osc.stop).toHaveBeenCalled();
        const startTime = osc.start.mock.calls[0][0];
        const stopTime = osc.stop.mock.calls[0][0];
        expect(stopTime - startTime).toBeCloseTo(QUARTER_AT_120 / 1000, 5);
      });

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('inserts the warmth filter (lowpass at 3 kHz)', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      expect(graph.filters).toHaveLength(1);
      expect(graph.filters[0].type).toBe('lowpass');
      expect(graph.filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(
        3000,
        expect.any(Number)
      );

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('schedules an ADSR envelope in order: silent → attack peak → decay → sustain hold → release', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // The envelope gain is identified by its first ramp target: the attack peak (1.0).
      const envelopeGain = graph.gains.find(
        (g) => g.gain.linearRampToValueAtTime.mock.calls[0]?.[0] === 1.0
      );
      expect(envelopeGain).toBeDefined();

      const setCalls = envelopeGain.gain.setValueAtTime.mock.calls;
      const rampCalls = envelopeGain.gain.linearRampToValueAtTime.mock.calls;

      // Piano sustain = 0.3 (per Piano.envelope).
      // Schedule: setValueAtTime(0), ramp→1, ramp→0.3, setValueAtTime(0.3), ramp→0
      expect(setCalls).toHaveLength(2);
      expect(rampCalls).toHaveLength(3);

      expect(setCalls[0][0]).toBe(0); // 1. silent at t0
      expect(rampCalls[0][0]).toBe(1.0); // 2. attack peak
      expect(rampCalls[1][0]).toBeCloseTo(0.3, 5); // 3. decay landing on sustain
      expect(setCalls[1][0]).toBeCloseTo(0.3, 5); // 4. hold sustain
      expect(rampCalls[2][0]).toBe(0); // 5. release to silence

      // Times must be monotonically non-decreasing in the order shown above.
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

    it('routes harmonics through their own gain node before the filter', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 1 volumeGain + 1 envelopeGain + 4 harmonic gains = 6 gain nodes
      expect(graph.gains).toHaveLength(6);

      // The 4 harmonic gains are the ones connected to the filter.
      const harmonicGains = graph.gains.filter((g) =>
        g.connect.mock.calls.some((call) => call[0] === graph.filters[0])
      );
      expect(harmonicGains).toHaveLength(4);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('rests', () => {
    it('produces no oscillators when pitch is missing', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ length: '1/4' }], // no pitch = rest
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      expect(graph.oscillators).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('chords', () => {
    it('plays all chord tones simultaneously', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [
          [
            { pitch: 'C/4', length: '1/4' },
            { pitch: 'E/4', length: '1/4' },
            { pitch: 'G/4', length: '1/4' },
          ],
        ],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 3 notes × 7 oscillators each = 21
      expect(graph.oscillators).toHaveLength(21);

      // All three fundamentals present in the triangle set (rounded to whole Hz
      // so the test survives table-rounding changes in noteFrequencies).
      const triangleFreqs = graph.oscillators
        .filter((o) => o.type === 'triangle')
        .map((o) => Math.round(o.frequency.setValueAtTime.mock.calls[0][0]));
      expect(triangleFreqs).toEqual(expect.arrayContaining([262, 330, 392]));

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('note callback', () => {
    it('fires the callback once per pitched note', async () => {
      const piano = new Piano();
      const onNote = jest.fn();
      piano.noteCallback = onNote;

      const playPromise = piano.play({
        data: [
          { pitch: 'C/4', length: '1/4' },
          { pitch: 'E/4', length: '1/4' },
        ],
        tempo: 120,
        basis: 4,
      });

      await Promise.resolve();
      expect(onNote).toHaveBeenCalledTimes(1);
      expect(onNote.mock.calls[0][0].pitch).toBe('C/4');

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      expect(onNote).toHaveBeenCalledTimes(2);
      expect(onNote.mock.calls[1][0].pitch).toBe('E/4');

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('does not fire for rests', async () => {
      const piano = new Piano();
      const onNote = jest.fn();
      piano.noteCallback = onNote;

      const playPromise = piano.play({
        data: [{ length: '1/4' }, { pitch: 'C/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });

      await Promise.resolve();
      expect(onNote).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      expect(onNote).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('pause and resume', () => {
    it('pause from mid-note advances by one note before honoring the stop (known quirk; see comment)', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [
          { pitch: 'C/4', length: '1/4' },
          { pitch: 'D/4', length: '1/4' },
          { pitch: 'E/4', length: '1/4' },
        ],
        tempo: 120,
        basis: 4,
      });

      await Promise.resolve();
      // First note is sounding — pause partway through.
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 / 2);
      piano.pause();

      // Pause schedules a 50ms fade-out, then sets shouldStop so the next
      // sleep in the play loop returns and saves the index.
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;

      expect(piano.playbackState.isPaused).toBe(true);
      expect(piano.playbackState.isPlaying).toBe(false);
      // Note: pause() sets shouldStop but does not interrupt an in-flight
      // sleep(). The play loop is mid-sleep waiting for note 1 (D); the sleep
      // completes, the loop plays D, *then* the i=2 iteration sees shouldStop
      // and saves currentIndex=2. So pause from mid-note advances by one note.
      // This is established behavior; locking it in so a refactor can't change
      // it silently.
      expect(piano.playbackState.currentIndex).toBe(2);
      expect(piano.playbackState.currentData).toHaveLength(3);
    });

    it('resume continues playback from the saved index, firing remaining notes in order', async () => {
      const piano = new Piano();
      const onNote = jest.fn();
      piano.noteCallback = onNote;

      const playPromise = piano.play({
        data: [
          { pitch: 'C/4', length: '1/4' },
          { pitch: 'D/4', length: '1/4' },
          { pitch: 'E/4', length: '1/4' },
        ],
        tempo: 120,
        basis: 4,
      });

      await Promise.resolve();
      expect(onNote).toHaveBeenCalledTimes(1);
      expect(onNote.mock.calls[0][0].pitch).toBe('C/4');

      // Pause partway through the first note. (See pause-test note above:
      // D will still play before the loop honors shouldStop, landing index at 2.)
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 / 2);
      piano.pause();

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;

      expect(piano.playbackState.isPaused).toBe(true);
      expect(piano.playbackState.currentIndex).toBe(2);
      expect(onNote).toHaveBeenCalledTimes(2);
      expect(onNote.mock.calls[1][0].pitch).toBe('D/4');

      // Resume — the next note should be E/4 (index 2). The resumed loop's
      // first wait is to playSchedule[2].playTime = 1000ms (elapsedTime starts at 0).
      const resumePromise = piano.resume();
      await Promise.resolve();
      expect(piano.playbackState.isPlaying).toBe(true);
      expect(piano.playbackState.isPaused).toBe(false);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 2);
      expect(onNote).toHaveBeenCalledTimes(3);
      expect(onNote.mock.calls[2][0].pitch).toBe('E/4');

      // Trailing post-loop sleep equal to last note duration.
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await resumePromise;

      expect(piano.playbackState.isPlaying).toBe(false);
      expect(piano.playbackState.isPaused).toBe(false);
    });

    it('ignores a second play() while one is already in flight', async () => {
      const piano = new Piano();
      const onNote = jest.fn();
      piano.noteCallback = onNote;

      const first = piano.play({
        data: [
          { pitch: 'C/4', length: '1/4' },
          { pitch: 'D/4', length: '1/4' },
        ],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();
      expect(onNote).toHaveBeenCalledTimes(1);

      // Re-entering play() should early-return without disturbing the in-flight phrase.
      const second = piano.play({
        data: [{ pitch: 'G/5', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await second;
      expect(onNote).toHaveBeenCalledTimes(1);
      const callsAfterDoubleInvoke = onNote.mock.calls.map((c) => c[0].pitch);
      expect(callsAfterDoubleInvoke).toEqual(['C/4']); // not 'G/5'

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      expect(onNote).toHaveBeenCalledTimes(2);
      expect(onNote.mock.calls[1][0].pitch).toBe('D/4');

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await first;
    });

    it('stop clears playback state and fades active oscillators', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [
          { pitch: 'C/4', length: '1/4' },
          { pitch: 'D/4', length: '1/4' },
        ],
        tempo: 120,
        basis: 4,
      });

      await Promise.resolve();
      const oscBeforeStop = graph.oscillators.length;
      expect(oscBeforeStop).toBe(7);

      piano.stop();

      // Every active oscillator was scheduled to stop with a fade.
      graph.oscillators.forEach((osc) => {
        expect(osc.stop).toHaveBeenCalled();
      });

      expect(piano.playbackState.isPlaying).toBe(false);
      expect(piano.playbackState.isPaused).toBe(false);
      expect(piano.playbackState.currentIndex).toBe(0);
      expect(piano.playbackState.currentData).toBeNull();

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 2);
      await playPromise;
    });
  });

  describe('updateVolume', () => {
    it('ramps the volume gain (not harmonic gains) toward the new volume', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // The first gain created in Piano.startNote is volumeGain — that's the
      // node tracked alongside every oscillator and the one updateVolume targets.
      const volumeGain = graph.gains[0];
      const harmonicGains = graph.gains.slice(2); // [0]=volumeGain, [1]=envelopeGain
      // setTargetAtTime isn't in the mock; install it on every gain so we can
      // distinguish which ones actually receive the ramp.
      graph.gains.forEach((g) => {
        g.gain.setTargetAtTime = jest.fn();
      });

      piano.updateVolume(0.25);
      expect(piano.volumeMultiplier).toBe(0.25);

      // The tracked volume gain receives the ramp with the new value.
      expect(volumeGain.gain.setTargetAtTime).toHaveBeenCalled();
      const [target, , timeConstant] = volumeGain.gain.setTargetAtTime.mock.calls[0];
      expect(target).toBe(0.25);
      expect(timeConstant).toBeCloseTo(0.01, 5);

      // Harmonic gains are not the tracked node and should not be touched.
      harmonicGains.forEach((g) => {
        expect(g.gain.setTargetAtTime).not.toHaveBeenCalled();
      });

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('note offsets', () => {
    it('shifts a note later by the offset value while keeping later notes anchored to natural time', async () => {
      const piano = new Piano();
      const onNote = jest.fn();
      piano.noteCallback = onNote;

      const playPromise = piano.play({
        data: [
          { pitch: 'C/4', length: '1/4' }, // plays at t=0
          { pitch: 'D/4', length: '1/4', offset: 100 }, // natural=500, plays at 600
          { pitch: 'E/4', length: '1/4' }, // natural=1000, plays at 1000
        ],
        tempo: 120,
        basis: 4,
      });

      await Promise.resolve();
      expect(onNote).toHaveBeenCalledTimes(1);

      // Advance to 500ms — D should NOT have fired yet (offset pushed it to 600)
      await jest.advanceTimersByTimeAsync(500);
      expect(onNote).toHaveBeenCalledTimes(1);

      // Advance another 100ms — now D fires at 600
      await jest.advanceTimersByTimeAsync(100);
      expect(onNote).toHaveBeenCalledTimes(2);
      expect(onNote.mock.calls[1][0].pitch).toBe('D/4');

      // E fires at natural time 1000ms → 400ms more from now
      await jest.advanceTimersByTimeAsync(400);
      expect(onNote).toHaveBeenCalledTimes(3);
      expect(onNote.mock.calls[2][0].pitch).toBe('E/4');

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });
});
