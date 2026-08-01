import audioContextManager from './AudioContextManager';
import Piano from '../instruments/Piano';
import { initInstruments, getInstrument } from './instrumentRegistry';

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
