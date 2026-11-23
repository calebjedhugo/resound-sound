/**
 * Mute: every sound the library plays live reaches the speakers through one
 * master output (`audioContextManager.getOutput()`), and
 * `audioContextManager.setMuted()` silences all of it by fading that
 * output's gain. The context itself keeps running, so its clock and
 * everything scheduled on it carry on while muted. Offline renders (the
 * Piano's warm-up buffers) keep their own destination: muting the speakers
 * must not bake silence into a cached note.
 */
let lib;
let manager;

beforeEach(() => {
  // A fresh library each test: a fresh context, output and mute state
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    lib = require('../index');
  });
  manager = lib.audioContextManager;
});

/** Where a gain ends up once its scheduled automation has run. */
function settledGain(param) {
  const events = [
    ...param.setValueAtTime.mock.calls.map(([value, time], i) => ({
      value, time, order: param.setValueAtTime.mock.invocationCallOrder[i],
    })),
    ...param.linearRampToValueAtTime.mock.calls.map(([value, time], i) => ({
      value, time, order: param.linearRampToValueAtTime.mock.invocationCallOrder[i],
    })),
  ];
  if (events.length === 0) return param.value;
  events.sort((a, b) => a.time - b.time || a.order - b.order);
  return events[events.length - 1].value;
}

/** Everything connected straight into the live context's speakers. */
const intoSpeakers = () => manager.getContext().destination.inputs;

/** Whether anything at all can be heard: what reaches the speakers, at its level. */
const audible = () => intoSpeakers().some((node) => !node.gain || settledGain(node.gain) > 0);

const SOUNDS = [
  ['a Synth note', () => new lib.Synth('s').startNote('C/4', 200)],
  ['a live Piano note', () => new lib.Piano('p', { autoSample: false }).startNote('C/4', 200)],
  ['a Piano note played from its warmed buffer', async () => {
    const piano = new lib.Piano('p');
    await piano.warm(['C/4']);
    piano.startNote('C/4', 200);
  }],
  ['a Fountain note', () => new lib.Fountain().startNote('C/4', 200)],
  ['a Random note', () => new lib.Random('r').startNote('C/4', 200)],
  ['a Random note above 88.2 kHz (the old graph)', () => {
    manager.getContext().sampleRate = 96000;
    new lib.Random('r').startNote('C/4', 200);
  }],
  ['a clap', () => new lib.Clap().clap()],
  ['a metronome click', () => {
    const clock = new lib.MusicalClock(120);
    clock.enableMetronome();
    clock.update(0.6);
  }],
];

describe('every live sound goes through the master output', () => {
  it.each(SOUNDS)('%s reaches the speakers only through the master', async (_name, play) => {
    await play();

    expect(intoSpeakers()).toEqual([manager.getOutput()]);
    expect(manager.getOutput().inputs.length).toBeGreaterThan(0);
  });

  it.each(SOUNDS)('muted, %s is not heard', async (_name, play) => {
    manager.setMuted(true);

    await play();

    expect(intoSpeakers().length).toBeGreaterThan(0);
    expect(audible()).toBe(false);
  });

  it('the iOS unlock blip goes through the master too', () => {
    const context = manager.getContext();
    const blip = context.destination.inputs[0].inputs[0];

    expect(context.destination.inputs).toEqual([manager.getOutput()]);
    expect(blip.buffer).toBeTruthy();
  });
});

describe('setMuted', () => {
  it('starts unmuted', () => {
    expect(manager.isMuted()).toBe(false);
    new lib.Synth('s').startNote('C/4', 200);
    expect(audible()).toBe(true);
  });

  it('fades out and back in, briefly, rather than jumping (no click)', () => {
    const { gain } = manager.getOutput();
    const context = manager.getContext();
    context.currentTime = 5;

    manager.setMuted(true);
    const [[outTo, outAt]] = gain.linearRampToValueAtTime.mock.calls;
    expect(outTo).toBe(0);
    expect(outAt - 5).toBeGreaterThan(0);
    expect(outAt - 5).toBeLessThanOrEqual(0.05);

    manager.setMuted(false);
    expect(manager.isMuted()).toBe(false);
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, expect.any(Number));
    expect(settledGain(gain)).toBe(1);
  });

  it('called before there is any context, the master is silent from the start', () => {
    manager.setMuted(true);
    expect(manager.context).toBeNull(); // muting alone builds no context

    new lib.Synth('s').startNote('C/4', 200);

    expect(manager.isMuted()).toBe(true);
    expect(audible()).toBe(false);
  });

  it('while the context waits for a gesture, the master goes silent at once', () => {
    const context = manager.getContext();
    context.state = 'suspended';

    manager.setMuted(true);

    expect(manager.getOutput().gain.value).toBe(0);
    expect(audible()).toBe(false);
  });
});

describe('muted, time keeps running', () => {
  it('never suspends the context', () => {
    const context = manager.getContext();
    const suspend = jest.spyOn(context, 'suspend');

    manager.setMuted(true);
    manager.setMuted(false);
    manager.setMuted(true);

    expect(suspend).not.toHaveBeenCalled();
    expect(context.state).toBe('running');
  });

  it('a phrase plays on to its end, every note started on schedule', async () => {
    manager.setMuted(true);
    const synth = new lib.Synth('s');
    const startNote = jest.spyOn(synth, 'startNote');

    const done = synth.play({
      data: [
        { pitch: 'C/4', length: '1/4' },
        { pitch: 'D/4', length: '1/4' },
        { pitch: 'E/4', length: '1/4' },
      ],
      tempo: 120,
      basis: 4,
    });
    await jest.advanceTimersByTimeAsync(2000);
    await done;

    expect(startNote.mock.calls.map(([pitch]) => pitch)).toEqual(['C/4', 'D/4', 'E/4']);
    expect(synth.playbackState.isPlaying).toBe(false);
  });

  it('the musical clock counts beats', () => {
    manager.setMuted(true);
    const clock = new lib.MusicalClock(120);

    clock.update(1.5);

    expect(clock.getCurrentBeat()).toBeCloseTo(3);
  });
});

describe('offline renders keep their own destination', () => {
  it("a Piano's warm-up renders into its offline context even while muted", async () => {
    manager.setMuted(true);
    const rendered = [];
    const RealOffline = global.OfflineAudioContext;
    global.OfflineAudioContext = class extends RealOffline {
      startRendering() {
        rendered.push(this);
        return super.startRendering();
      }
    };
    try {
      const piano = new lib.Piano('p');
      await piano.warm(['C/4']);
    } finally {
      global.OfflineAudioContext = RealOffline;
    }

    expect(rendered.length).toBeGreaterThan(0);
    rendered.forEach((offline) => {
      // The note is drawn straight into the render, at full level
      expect(offline.destination.inputs.length).toBeGreaterThan(0);
      expect(offline.destination.inputs).not.toContain(manager.getOutput());
    });
    // ...and nothing of the render reaches the live master
    const renderNodes = new Set(rendered.flatMap((offline) => offline.destination.inputs));
    expect(manager.getOutput().inputs.some((node) => renderNodes.has(node))).toBe(false);
  });
});
