import audioContextManager from './AudioContextManager';
import Piano from '../instruments/Piano';
import { initInstruments, getInstrument, instrumentReady } from './instrumentRegistry';

// Eager-initialization: construct + warm sampled instruments at page load,
// outside a user gesture. See SPEC-init.md.
describe('initInstruments / getInstrument', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // Leave the shared singleton context/document mock clean for later tests.
    const context = audioContextManager.getContext();
    context.state = 'running';
    audioContextManager.gestureListenersInstalled = false;
    document.listeners = {};
  });

  it('creates and registers a Piano under its id; getInstrument finds it', async () => {
    const { piano } = await initInstruments({
      piano: { id: 'init-basic', pitches: ['C/4'] },
    });

    expect(piano).toBeInstanceOf(Piano);
    expect(piano.id).toBe('init-basic');
    expect(getInstrument('init-basic')).toBe(piano);
  });

  it('is idempotent: a second call with the same id returns the same instance and warms new pitches', async () => {
    const { piano: first } = await initInstruments({
      piano: { id: 'init-idempotent', layers: [0.3, 0.7], pitches: ['C/4'] },
    });
    const warmSpy = jest.spyOn(first, 'warm');

    const { piano: second } = await initInstruments({
      piano: { id: 'init-idempotent', layers: [0.3, 0.7], pitches: ['D/4'] },
    });

    expect(second).toBe(first);
    expect(warmSpy).toHaveBeenCalledWith(['D/4']);
  });

  it('warns and keeps the original layers when a second call conflicts', async () => {
    const { piano: first } = await initInstruments({
      piano: { id: 'init-conflict', layers: [0.3, 0.7], pitches: ['C/4'] },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { piano: second } = await initInstruments({
      piano: { id: 'init-conflict', layers: [0.1, 0.5, 0.9], pitches: ['D/4'] },
    });

    expect(second).toBe(first);
    expect(first.velocityLayers).toEqual([0.3, 0.7]); // first call wins
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not warn again when the second call repeats the same layers', async () => {
    const { piano: first } = await initInstruments({
      piano: { id: 'init-same-layers', layers: [0.4, 0.6], pitches: ['C/4'] },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await initInstruments({
      piano: { id: 'init-same-layers', layers: [0.4, 0.6], pitches: ['D/4'] },
    });

    expect(first.velocityLayers).toEqual([0.4, 0.6]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves to {} and touches nothing when called with no config', async () => {
    const getContextSpy = jest.spyOn(audioContextManager, 'getContext');

    const resultNoArgs = await initInstruments();
    const resultEmpty = await initInstruments({});

    expect(resultNoArgs).toEqual({});
    expect(resultEmpty).toEqual({});
    expect(getContextSpy).not.toHaveBeenCalled();
  });

  it('does not register a plain `new Piano(id)` instance', () => {
    // eslint-disable-next-line no-new
    new Piano('not-registered-directly');
    expect(getInstrument('not-registered-directly')).toBeUndefined();
    expect(getInstrument('some-id-never-initialized')).toBeUndefined();
  });

  // A play button tapped mid-init has to wait for the init that is already
  // running — the alternative is a second instrument racing the first, with the
  // whole pre-render paid twice and the eagerly warmed one thrown away.
  describe('instrumentReady', () => {
    /** A warm() that only finishes when the test says so. */
    function deferredWarm() {
      let release;
      const done = new Promise((resolve) => { release = resolve; });
      jest.spyOn(Piano.prototype, 'warm').mockReturnValue(done);
      return release;
    }

    /** Tracks settlement without awaiting, so "not yet" is assertable. */
    function watch(promise) {
      const state = { settled: false, value: undefined };
      promise.then((value) => { state.settled = true; state.value = value; });
      return state;
    }

    // The suite runs on fake timers, so drain the microtask queue by hand —
    // everything here is promise-chained, nothing waits on a timer.
    const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

    it('resolves on the spot when nothing is initializing', async () => {
      await initInstruments({ piano: { id: 'ready-idle', pitches: ['C/4'] } });

      await expect(instrumentReady('ready-idle')).resolves.toBe(getInstrument('ready-idle'));
      await expect(instrumentReady('ready-never-initialized')).resolves.toBeUndefined();
    });

    it('waits for an init still warming, then hands back that same instance', async () => {
      const release = deferredWarm();
      const init = initInstruments({ piano: { id: 'ready-inflight', pitches: ['C/4'] } });
      const waiter = watch(instrumentReady('ready-inflight'));

      await flush();
      expect(waiter.settled).toBe(false); // still rendering

      release();
      await init;
      await flush();

      expect(waiter.settled).toBe(true);
      expect(waiter.value).toBe(getInstrument('ready-inflight'));
    });

    it('waits for a second init that started while the first was still warming', async () => {
      // singHarmony2 does exactly this: the page-load range warm is still
      // running when opening a hymn warms that hymn's pitches.
      const releaseFirst = deferredWarm();
      const first = initInstruments({ piano: { id: 'ready-overlap', pitches: ['C/4'] } });
      const releaseSecond = deferredWarm();
      const second = initInstruments({ piano: { id: 'ready-overlap', pitches: ['D/4'] } });
      const waiter = watch(instrumentReady('ready-overlap'));

      releaseSecond();
      await second;
      await flush();
      expect(waiter.settled).toBe(false); // the page-load warm is still going

      releaseFirst();
      await first;
      await flush();
      expect(waiter.settled).toBe(true);
    });

    it('resolves rather than rejecting when warming fails, so a loader always clears', async () => {
      jest.spyOn(Piano.prototype, 'warm').mockRejectedValue(new Error('no OfflineAudioContext'));
      const init = initInstruments({ piano: { id: 'ready-failed', pitches: ['C/4'] } });

      await expect(init).rejects.toThrow('no OfflineAudioContext');
      // an unwarmed piano still plays — it just renders live
      await expect(instrumentReady('ready-failed')).resolves.toBe(getInstrument('ready-failed'));
    });

    it('stops waiting once the init has settled', async () => {
      const release = deferredWarm();
      const init = initInstruments({ piano: { id: 'ready-cleared', pitches: ['C/4'] } });
      release();
      await init;

      const waiter = watch(instrumentReady('ready-cleared'));
      await flush();

      expect(waiter.settled).toBe(true);
    });
  });

  describe('gesture-resume', () => {
    it('installs exactly one set of listeners on a suspended context, and dispatching pointerdown resumes + removes them', () => {
      const context = audioContextManager.getContext();
      context.state = 'suspended';
      const resumeSpy = jest.spyOn(context, 'resume');

      audioContextManager.resumeOnFirstGesture();
      expect(document.listeners.pointerdown).toHaveLength(1);
      expect(document.listeners.keydown).toHaveLength(1);
      expect(document.listeners.touchend).toHaveLength(1);

      // Calling again before the gesture fires must never double the listeners.
      audioContextManager.resumeOnFirstGesture();
      expect(document.listeners.pointerdown).toHaveLength(1);
      expect(document.listeners.keydown).toHaveLength(1);
      expect(document.listeners.touchend).toHaveLength(1);

      document.dispatchEvent({ type: 'pointerdown' });

      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(document.listeners.pointerdown).toHaveLength(0);
      expect(document.listeners.keydown).toHaveLength(0);
      expect(document.listeners.touchend).toHaveLength(0);
    });

    it('installs no listeners when the context is already running', () => {
      const context = audioContextManager.getContext();
      context.state = 'running';

      audioContextManager.resumeOnFirstGesture();

      expect(document.listeners.pointerdown ?? []).toHaveLength(0);
      expect(document.listeners.keydown ?? []).toHaveLength(0);
      expect(document.listeners.touchend ?? []).toHaveLength(0);
    });
  });
});
