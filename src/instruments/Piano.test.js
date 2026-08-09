import audioContextManager from '../lib/AudioContextManager';
import { getFrequency } from '../lib/noteFrequencies';
import Piano from './Piano';

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

  // Voice counts are register-dependent (partials + unison pairs); derive them
  // from the model itself so these tests survive tuning-constant changes.
  const voiceCount = (pitch) => new Piano().buildVoices(getFrequency(pitch)).length;
  const A4_VOICES = voiceCount('A/4');

  describe('a single note', () => {
    it('schedules one decaying sine oscillator per voice', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });

      // Note is dispatched synchronously at index 0; let microtasks settle.
      await Promise.resolve();

      // Additive timbre: every voice is its own oscillator, set to a
      // single-harmonic wavetable (a sine at a seeded random start phase).
      expect(graph.oscillators).toHaveLength(A4_VOICES);
      graph.oscillators.forEach((osc) => expect(osc.type).toBe('custom'));

      const freqs = graph.oscillators
        .map((osc) => osc.frequency.setValueAtTime.mock.calls[0][0])
        .sort((a, b) => a - b);
      // The lowest voices are the fundamental's detuned unison pair (~440 Hz).
      expect(freqs[0]).toBeGreaterThan(435);
      expect(freqs[0]).toBeLessThan(445);
      // Higher partials climb the harmonic series: something near the 2nd (~880)
      // and 3rd (~1320) partials is present.
      expect(freqs.some((f) => f > 860 && f < 900)).toBe(true);
      expect(freqs.some((f) => f > 1290 && f < 1360)).toBe(true);
      expect(Math.max(...freqs)).toBeLessThan(7000);

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

    it('inserts one non-resonant lowpass filter for the hammer thump', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // Partial brightness is baked into the amplitudes; the only biquad is the
      // lowpass shaping the soft felt-hammer knock (no resonant "bamboo" ping).
      expect(graph.filters).toHaveLength(1);
      expect(graph.filters[0].type).toBe('lowpass');

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('gives each voice a bloom → prompt → tail → damper envelope', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // 1 volumeGain + one gain per voice + 1 hammer-noise gain.
      expect(graph.gains).toHaveLength(2 + A4_VOICES);

      // Voice gains are the ones with linear ramps scheduled (bloom + damper);
      // the volume gain sets a static value and the hammer gain only has an
      // exponential decay, so this cleanly selects the partial voices.
      const voiceGains = graph.gains.filter(
        (g) => g.gain.linearRampToValueAtTime.mock.calls.length > 0
      );
      expect(voiceGains).toHaveLength(A4_VOICES);

      voiceGains.forEach((g) => {
        const setCalls = g.gain.setValueAtTime.mock.calls;
        const linCalls = g.gain.linearRampToValueAtTime.mock.calls;
        const expCalls = g.gain.exponentialRampToValueAtTime.mock.calls;

        // Double-decay envelope: setValueAtTime(~0) → linear bloom up → exp
        // "prompt" drop to the knee → exp long tail → linear damper to ~0.
        expect(setCalls[0][0]).toBeCloseTo(0, 3); // near-silent start
        const bloomPeak = linCalls[0][0];
        expect(bloomPeak).toBeGreaterThan(0);
        expect(expCalls).toHaveLength(2); // prompt + tail
        const knee = expCalls[0][0];
        const tailTarget = expCalls[1][0];
        expect(knee).toBeGreaterThan(0);
        expect(knee).toBeLessThan(bloomPeak); // prompt heads downward
        expect(tailTarget).toBeGreaterThan(0);
        expect(tailTarget).toBeLessThan(knee); // tail keeps decaying
        // Final event returns to (near) silence for a click-free release.
        expect(linCalls[linCalls.length - 1][0]).toBeCloseTo(0, 3);

        // Times strictly advance: bloom < prompt < tail < damper.
        const bloomT = linCalls[0][1];
        const promptT = expCalls[0][1];
        const tailT = expCalls[1][1];
        const damperT = linCalls[linCalls.length - 1][1];
        expect(promptT).toBeGreaterThan(bloomT);
        expect(tailT).toBeGreaterThan(promptT);
        expect(damperT).toBeGreaterThanOrEqual(tailT);
      });

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });

    it('routes every voice through its own gain into the volume gain', async () => {
      const piano = new Piano();
      const playPromise = piano.play({
        data: [{ pitch: 'A/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await Promise.resolve();

      // volumeGain is created first. Voice gains are those with linear ramps.
      const volumeGain = graph.gains[0];
      const voiceGains = graph.gains.filter(
        (g) => g.gain.linearRampToValueAtTime.mock.calls.length > 0
      );
      expect(voiceGains).toHaveLength(A4_VOICES);

      // Each voice gain connects to the volume gain.
      voiceGains.forEach((g) => {
        expect(g.connect.mock.calls.some((call) => call[0] === volumeGain)).toBe(true);
      });

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

      // Each note contributes its own register-dependent voice count.
      const expected = voiceCount('C/4') + voiceCount('E/4') + voiceCount('G/4');
      expect(graph.oscillators).toHaveLength(expected);

      // All three fundamentals are present. Each is struck as a unison pair
      // detuned a few cents, so assert a voice lands within ~1% of each.
      const freqs = graph.oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0]);
      [262, 330, 392].forEach((target) => {
        expect(freqs.some((f) => Math.abs(f - target) / target < 0.01)).toBe(true);
      });

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
      // Only the first note (C/4) has been dispatched.
      const oscBeforeStop = graph.oscillators.length;
      expect(oscBeforeStop).toBe(voiceCount('C/4'));

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
    it('ramps the volume gain (not voice gains) toward the new volume', async () => {
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
      const otherGains = graph.gains.slice(1); // voice gains + hammer gain
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

      // Voice/hammer gains are not the tracked node and should not be touched.
      otherGains.forEach((g) => {
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

  // Opt-in sampled playback: warm() pre-renders pitches to buffers so they play
  // back cheaply. Default (un-warmed) behaviour stays the full live synth above.
  describe('sampled playback (warm)', () => {
    // Count node creation on the singleton (live) context. Offline pre-rendering
    // happens on separate OfflineAudioContext instances, so it never shows here.
    function captureCounts() {
      const context = audioContextManager.getContext();
      jest.restoreAllMocks(); // drop the outer beforeEach captureGraph spies
      const counts = { oscillators: 0, gains: 0, bufferSources: 0 };
      const origOsc = context.createOscillator.bind(context);
      const origGain = context.createGain.bind(context);
      const origSrc = context.createBufferSource.bind(context);
      jest.spyOn(context, 'createOscillator').mockImplementation(() => { counts.oscillators += 1; return origOsc(); });
      jest.spyOn(context, 'createGain').mockImplementation(() => { counts.gains += 1; return origGain(); });
      jest.spyOn(context, 'createBufferSource').mockImplementation(() => { counts.bufferSources += 1; return origSrc(); });
      return counts;
    }

    it('warm() pre-renders every pitch × velocity layer into the cache', async () => {
      const piano = new Piano('p', { layers: [0.3, 0.7] });
      expect(piano.sampleBuffers.size).toBe(0);
      await piano.warm(['C/2', 'C/4']);
      expect(piano.sampleBuffers.size).toBe(4); // 2 pitches × 2 layers
      expect(piano.sampleBuffers.has(`${piano.midiFromFreq(getFrequency('C/4'))}:1`)).toBe(true);
    });

    it('a warmed note plays back as a single buffer source — not dozens of oscillators', async () => {
      const piano = new Piano('p', { layers: [0.2, 0.5, 0.8] });
      await piano.warm(['C/2']);

      const counts = captureCounts();
      const play = piano.play({ data: [{ pitch: 'C/2', length: '1/4', velocity: 0.8 }], tempo: 120, basis: 4 });
      await Promise.resolve();

      expect(counts.oscillators).toBe(0); // no live voices
      expect(counts.bufferSources).toBe(1); // one buffer
      expect(counts.gains).toBe(1); // one gain

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await play;
    });

    it('by default an un-warmed note renders live, then auto-caches for next time', async () => {
      const piano = new Piano('p');
      const counts = captureCounts();
      const play = piano.play({ data: [{ pitch: 'C/2', length: '1/4', velocity: 0.7 }], tempo: 120, basis: 4 });
      await Promise.resolve();

      const liveVoices = new Piano('ref', { autoSample: false }).buildVoices(getFrequency('C/2'), 0.7).length;
      expect(counts.oscillators).toBe(liveVoices); // first strike is the full live synth
      // ...and a background render was scheduled so the next strike is cheap.
      expect(piano.pendingRenders.size + piano.sampleBuffers.size).toBeGreaterThan(0);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await play;
    });

    it('{ autoSample: false } stays pure live — no cache, no background rendering', async () => {
      const piano = new Piano('p', { autoSample: false });
      const counts = captureCounts();
      const play = piano.play({ data: [{ pitch: 'C/2', length: '1/4', velocity: 0.7 }], tempo: 120, basis: 4 });
      await Promise.resolve();

      expect(counts.oscillators).toBeGreaterThan(0); // live
      expect(piano.sampleBuffers.size).toBe(0);
      expect(piano.pendingRenders.size).toBe(0);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await play;
    });

    it('picks the nearest velocity layer', () => {
      const piano = new Piano('p', { layers: [0.2, 0.5, 0.8] });
      expect(piano.nearestLayerIndex(0.2)).toBe(0);
      expect(piano.nearestLayerIndex(0.38)).toBe(1);
      expect(piano.nearestLayerIndex(1.0)).toBe(2);
    });

    it('speculative auto-cache renders are bounded by the warm pool', async () => {
      const piano = new Piano('p');
      const pending = [];
      jest.spyOn(piano, 'renderBuffer')
        .mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));

      // An un-warmed 8-note flurry: each strike plays live and wants a
      // background render. Only warmConcurrency renders may be in flight.
      const pitches = ['C/4', 'D/4', 'E/4', 'F/4', 'G/4', 'A/4', 'B/4', 'C/5'];
      pitches.forEach((pitch) => piano.startNote(pitch, 500));
      expect(piano.pendingRenders.size).toBe(piano.warmConcurrency);
      expect(piano._warmQueue.length).toBe(pitches.length - piano.warmConcurrency);

      // Drain: as each batch resolves, the pool starts the next.
      while (pending.length) {
        pending.splice(0).forEach((resolve) => resolve({ length: 10 }));
        // eslint-disable-next-line no-await-in-loop
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(piano.sampleBuffers.size).toBe(pitches.length);
      expect(piano.pendingRenders.size).toBe(0);
      expect(piano._warmQueue.length).toBe(0);
    });

    it('evicts least-recently-used buffers once the byte budget is exceeded', async () => {
      const ref = new Piano('ref-bytes');
      const bytes = (pitch) => Math.ceil(ref.bufferSeconds(getFrequency(pitch)) * 20050) * 4;
      // Budget fits C/5 + D/5 (and the shorter E/5), but never all three.
      const piano = new Piano('p', {
        layers: [0.7],
        maxCacheBytes: bytes('C/5') + bytes('D/5') + 16,
      });
      await piano.warm(['C/5']);
      await piano.warm(['D/5']);
      await piano.warm(['E/5']); // over budget: least-recently-used (C/5) goes
      const key = (pitch) => `${piano.midiFromFreq(getFrequency(pitch))}:0`;
      expect(piano.sampleBuffers.has(key('C/5'))).toBe(false);
      expect(piano.sampleBuffers.has(key('D/5'))).toBe(true);
      expect(piano.sampleBuffers.has(key('E/5'))).toBe(true);
      expect(piano.cacheBytes).toBeLessThanOrEqual(piano.maxCacheBytes);
    });

    it('a cache hit refreshes recency, protecting the buffer from eviction', async () => {
      const ref = new Piano('ref-bytes2');
      const bytes = (pitch) => Math.ceil(ref.bufferSeconds(getFrequency(pitch)) * 20050) * 4;
      const piano = new Piano('p', {
        layers: [0.7],
        maxCacheBytes: bytes('C/5') + bytes('D/5') + 16,
      });
      await piano.warm(['C/5']);
      await piano.warm(['D/5']);
      piano.startNote('C/5', 500, 0.7); // hit: C/5 becomes most recent
      await piano.warm(['E/5']); // now D/5 is the LRU entry
      const key = (pitch) => `${piano.midiFromFreq(getFrequency(pitch))}:0`;
      expect(piano.sampleBuffers.has(key('C/5'))).toBe(true);
      expect(piano.sampleBuffers.has(key('D/5'))).toBe(false);
      expect(piano.sampleBuffers.has(key('E/5'))).toBe(true);
    });

    it('still honors maxCacheEntries as an entry-count cap', async () => {
      const piano = new Piano('p', { layers: [0.7], maxCacheEntries: 2 });
      await piano.warm(['C/4']);
      await piano.warm(['D/4']);
      await piano.warm(['E/4']);
      expect(piano.sampleBuffers.size).toBe(2);
    });

    it('renders offline buffers at a reduced sample rate (synthesis caps at 7 kHz)', async () => {
      const piano = new Piano('p', { layers: [0.7] });
      await piano.warm(['C/4']);
      const buffer = piano.sampleBuffers.values().next().value;
      // min(live 44100, 20050) — the additive synth never exceeds 7 kHz, so a
      // ~20 kHz render carries the full spectrum at ~2.2x less CPU/memory.
      expect(buffer.sampleRate).toBe(20050);
      expect(buffer.length)
        .toBe(Math.ceil(piano.bufferSeconds(getFrequency('C/4')) * 20050));
    });

    it('bass buffers are longer than treble buffers', () => {
      const piano = new Piano();
      expect(piano.bufferSeconds(getFrequency('C/2')))
        .toBeGreaterThan(piano.bufferSeconds(getFrequency('C/5')));
    });
  });
});
