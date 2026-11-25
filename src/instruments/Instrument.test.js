import Instrument from './Instrument';
import Synth from './Synth';

// Base-class playback semantics, exercised through the documented extension
// point (a subclass implementing startNote). The concrete-instrument suites
// cover the audio graph; this one covers the play loop's state machine, where
// a wrong transition leaves an instrument wedged with no audible symptom.
class Recorder extends Instrument {
  constructor(id = 'recorder') {
    super(id);
    this.started = [];
  }

  startNote(pitch, duration, velocity) {
    this.started.push({ pitch, duration, velocity });
  }
}

const QUARTER_AT_120 = 500; // ms
const THREE_NOTES = [
  { pitch: 'C/4', length: '1/4' },
  { pitch: 'D/4', length: '1/4' },
  { pitch: 'E/4', length: '1/4' },
];

describe('Instrument', () => {
  it('requires a subclass to implement startNote', () => {
    const bare = new Instrument('bare');
    expect(() => bare.startNote('C/4', 500)).toThrow('startNote() must be implemented');
  });

  describe('play with nothing to play', () => {
    it('resolves and resets state for an empty phrase', async () => {
      const inst = new Recorder();

      await inst.play({ data: [], tempo: 120, basis: 4 });

      expect(inst.started).toHaveLength(0);
      expect(inst.playbackState.isPlaying).toBe(false);
      expect(inst.playbackState.isPaused).toBe(false);
      expect(inst.playbackState.currentIndex).toBe(0);
      expect(inst.playbackState.currentData).toBeNull();
    });

    it('resolves when data is missing entirely', async () => {
      const inst = new Recorder();
      await expect(inst.play({ tempo: 120, basis: 4 })).resolves.toBeUndefined();
      expect(inst.playbackState.isPlaying).toBe(false);
    });
  });

  describe('stop', () => {
    it('leaves the instrument stopped, not paused, once the loop unwinds', async () => {
      const inst = new Recorder();
      const playPromise = inst.play({ data: THREE_NOTES, tempo: 120, basis: 4 });
      await Promise.resolve();

      inst.stop();

      // The play loop is mid-sleep and, like pause(), does not interrupt it —
      // one more note straggles out before the loop honors the flag. What must
      // NOT happen is the loop re-parking the cleared state as a pause.
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 3);
      await playPromise;

      expect(inst.playbackState.isPlaying).toBe(false);
      expect(inst.playbackState.isPaused).toBe(false);
      expect(inst.playbackState.currentIndex).toBe(0);
      expect(inst.playbackState.currentData).toBeNull();
      expect(inst.started).toHaveLength(2); // never reached E/4
    });

    it('makes resume() after a stop a no-op rather than a crash', async () => {
      const inst = new Recorder();
      const playPromise = inst.play({ data: THREE_NOTES, tempo: 120, basis: 4 });
      await Promise.resolve();
      inst.stop();
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 3);
      await playPromise;

      await expect(inst.resume()).resolves.toBeUndefined();
      expect(inst.playbackState.isPlaying).toBe(false);
      expect(inst.started).toHaveLength(2); // nothing replayed
    });

    it('lets a phrase played before the stopped loop wakes play alone', async () => {
      const inst = new Recorder();
      const heard = [];
      inst.noteCallback = (event) => heard.push(event.pitch);
      const stopped = inst.play({ data: THREE_NOTES, tempo: 120, basis: 4 });
      await Promise.resolve();
      inst.stop();
      await jest.advanceTimersByTimeAsync(100);

      // The stopped loop sleeps until D/4 at 500; the new phrase runs 100-1100
      const next = inst.play({
        data: [{ pitch: 'F/4', length: '1/4' }, { pitch: 'G/4', length: '1/4' }],
        tempo: 120,
        basis: 4,
      });
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 2 - 50);
      // Nothing of the stopped phrase sounded, and the state is still the new one's
      expect(inst.started.map(({ pitch }) => pitch)).toEqual(['C/4', 'F/4', 'G/4']);
      expect(heard).toEqual(['C/4', 'F/4', 'G/4']);
      expect(inst.playbackState.isPlaying).toBe(true);
      expect(inst.playbackState.currentData).toHaveLength(2);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await Promise.all([stopped, next]);
      expect(inst.playbackState.isPlaying).toBe(false);
    });

    it('lets a phrase played during the stopped loop’s last note keep its state to its end', async () => {
      const inst = new Recorder();
      const stopped = inst.play({ data: [{ pitch: 'C/4', length: '1/1' }], tempo: 120, basis: 4 });
      await Promise.resolve();
      inst.stop();
      await jest.advanceTimersByTimeAsync(100);

      // The stopped loop waits out C/4 until 2000; the new phrase runs 100-2600
      const fiveQuarters = ['D/4', 'E/4', 'F/4', 'G/4', 'A/4'].map((pitch) => ({ pitch, length: '1/4' }));
      const next = inst.play({ data: fiveQuarters, tempo: 120, basis: 4 });
      await jest.advanceTimersByTimeAsync(2000);
      expect(inst.playbackState.isPlaying).toBe(true);
      expect(inst.playbackState.currentData).toBe(fiveQuarters);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await Promise.all([stopped, next]);
      expect(inst.started.map(({ pitch }) => pitch)).toEqual(['C/4', ...fiveQuarters.map((n) => n.pitch)]);
      expect(inst.playbackState.isPlaying).toBe(false);
    });
  });

  describe('dispose', () => {
    it('lets no note out of a play loop asleep between notes, and reports none', async () => {
      const inst = new Recorder();
      const heard = [];
      inst.noteCallback = (event) => heard.push(event.pitch);
      const playPromise = inst.play({ data: THREE_NOTES, tempo: 120, basis: 4 });
      await Promise.resolve();

      inst.dispose();

      // Where a stop() here lets D/4 straggle out (above), nothing does
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120 * 3);
      await playPromise;
      expect(inst.started.map(({ pitch }) => pitch)).toEqual(['C/4']);
      expect(heard).toEqual(['C/4']);
      expect(inst.playbackState.isPlaying).toBe(false);
    });

    it('fades what is sounding as a stop does', () => {
      const inst = new Recorder();
      const gainNode = inst.context.createGain();
      const oscillator = { stop: jest.fn() };
      inst.trackOscillator(oscillator, gainNode, 1000);

      inst.dispose();

      const end = inst.context.currentTime + 0.05; // stop()'s fade
      expect(gainNode.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, end);
      expect(oscillator.stop).toHaveBeenCalledWith(end);
    });

    it('plays nothing afterwards, chord or note', () => {
      const inst = new Recorder();
      const onNote = jest.fn();
      inst.noteCallback = onNote;
      inst.dispose();

      inst.playNoteImmediate({ pitch: 'C/4', length: '1/4' }, 120, 4);
      inst.playChordImmediate([{ pitch: 'E/4', length: '1/4' }], 120, 4);

      expect(inst.started).toHaveLength(0);
      expect(onNote).not.toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('ramps tracked notes to silence rather than cutting them off', () => {
      const inst = new Recorder();
      const gainNode = inst.context.createGain();
      const oscillator = { stop: jest.fn() };
      inst.trackOscillator(oscillator, gainNode, 1000);

      const fade = 0.05;
      inst.stopAll(fade);
      const end = inst.context.currentTime + fade;

      // Cancelling first is what makes the ramp win over the note's own
      // scheduled envelope; without it the fade does nothing and pausing clicks.
      expect(gainNode.gain.cancelScheduledValues).toHaveBeenCalled();
      expect(gainNode.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, end);
      expect(oscillator.stop).toHaveBeenCalledWith(end);
      expect(inst.activeOscillators.size).toBe(0);
    });

    it('survives a node that has already been stopped', () => {
      const inst = new Recorder();
      const gainNode = inst.context.createGain();
      gainNode.gain.cancelScheduledValues = () => { throw new Error('already stopped'); };
      inst.trackOscillator({ stop: jest.fn() }, gainNode, 1000);

      expect(() => inst.stopAll()).not.toThrow();
      expect(inst.activeOscillators.size).toBe(0);
    });

    it('fades a gain shared by many oscillators once, and stops every oscillator', () => {
      const inst = new Recorder();
      const shared = inst.context.createGain();
      const oscillators = [{ stop: jest.fn() }, { stop: jest.fn() }, { stop: jest.fn() }];
      oscillators.forEach((osc) => inst.trackOscillator(osc, shared, 1000));

      inst.stopAll(0.05);
      const end = inst.context.currentTime + 0.05;

      expect(shared.gain.cancelScheduledValues).toHaveBeenCalledTimes(1);
      expect(shared.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
      expect(shared.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, end);
      oscillators.forEach((osc) => expect(osc.stop).toHaveBeenCalledWith(end));
    });
  });

  describe('updateVolume', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('ramps each distinct gain once, however many oscillators play through it', () => {
      const inst = new Recorder();
      const shared = inst.context.createGain();
      const own = inst.context.createGain();
      inst.trackOscillator({ stop: jest.fn() }, shared, 1000);
      inst.trackOscillator({ stop: jest.fn() }, shared, 1000);
      inst.trackOscillator({ stop: jest.fn() }, own, 1000);

      inst.updateVolume(0.4);

      const { currentTime } = inst.context;
      expect(shared.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
      expect(shared.gain.setTargetAtTime).toHaveBeenCalledWith(0.4, currentTime, 0.01);
      expect(own.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
      expect(inst.volumeMultiplier).toBe(0.4);
    });

    it('schedules nothing for a volume it already has', () => {
      const inst = new Recorder();
      const gainNode = inst.context.createGain();
      inst.trackOscillator({ stop: jest.fn() }, gainNode, 1000);

      inst.updateVolume(0.4);
      inst.updateVolume(0.4);
      inst.updateVolume(0.4);

      expect(gainNode.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
    });

    it('starts a note played after a change at the new volume, so later frames owe it nothing', async () => {
      // The skip above relies on this: a gain created after the last change
      // already sits at the current volume (the per-frame re-ramp it no
      // longer gets would have been a no-op).
      const gains = [];
      const synth = new Synth();
      const origGain = synth.context.createGain.bind(synth.context);
      jest.spyOn(synth.context, 'createGain').mockImplementation(() => {
        const node = origGain();
        gains.push(node);
        return node;
      });
      synth.updateVolume(0.25);

      const playPromise = synth.play({ data: [{ pitch: 'A/4', length: '1/4' }], tempo: 120, basis: 4 });
      await Promise.resolve();
      synth.updateVolume(0.25);

      // Synth builds the volume gain first, then the envelope
      const volumeGain = gains[0];
      expect(volumeGain.gain.value).toBe(0.25);
      expect(volumeGain.gain.setTargetAtTime).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await playPromise;
    });
  });

  describe('blocking note helpers', () => {
    it('playNote sounds the note, emits it, and waits out its duration', async () => {
      const inst = new Recorder();
      const onNote = jest.fn();
      inst.noteCallback = onNote;

      let done = false;
      const promise = inst.playNote({ pitch: 'C/4', length: '1/4' }, 120, 4).then(() => { done = true; });

      await Promise.resolve();
      expect(inst.started).toEqual([{ pitch: 'C/4', duration: 500, velocity: undefined }]);
      expect(onNote).toHaveBeenCalledTimes(1);
      expect(done).toBe(false);

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await promise;
      expect(done).toBe(true);
    });

    it('playNote waits out a rest without sounding or emitting it', async () => {
      const inst = new Recorder();
      const onNote = jest.fn();
      inst.noteCallback = onNote;

      const promise = inst.playNote({ length: '1/4' }, 120, 4);
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await promise;

      expect(inst.started).toHaveLength(0);
      expect(onNote).not.toHaveBeenCalled();
    });

    it('playChord sounds every member and waits for the shortest', async () => {
      const inst = new Recorder();
      let done = false;
      const promise = inst.playChord([
        { pitch: 'C/4', length: '1/2' },
        { pitch: 'E/4', length: '1/4' },
      ], 120, 4).then(() => { done = true; });

      await Promise.resolve();
      expect(inst.started.map((n) => n.pitch)).toEqual(['C/4', 'E/4']);
      expect(inst.started[0].duration).toBe(1000); // each keeps its own length

      await jest.advanceTimersByTimeAsync(QUARTER_AT_120); // the shortest
      await promise;
      expect(done).toBe(true);
    });
  });

  describe('note events', () => {
    it('reports the instrument id and source position with each note', async () => {
      const inst = new Recorder('creature-7');
      inst.sourcePosition = { x: 1, y: 2, z: 3 };
      const onNote = jest.fn();
      inst.noteCallback = onNote;

      const promise = inst.playNote({ pitch: 'C/4', length: '1/4' }, 120, 4);
      await jest.advanceTimersByTimeAsync(QUARTER_AT_120);
      await promise;

      expect(onNote.mock.calls[0][0]).toMatchObject({
        pitch: 'C/4',
        length: '1/4',
        source: 'creature-7',
        sourcePosition: { x: 1, y: 2, z: 3 },
      });
    });

    it('emits the whole chord before any of it starts sounding', async () => {
      const inst = new Recorder();
      const order = [];
      inst.noteCallback = (event) => order.push(`emit:${event.pitch}`);
      const origStart = inst.startNote.bind(inst);
      inst.startNote = (pitch, duration, velocity) => {
        order.push(`start:${pitch}`);
        origStart(pitch, duration, velocity);
      };

      inst.playChordImmediate([
        { pitch: 'C/4', length: '1/4' },
        { pitch: 'E/4', length: '1/4' },
      ], 120, 4);

      expect(order).toEqual(['emit:C/4', 'emit:E/4', 'start:C/4', 'start:E/4']);
    });
  });

  describe('overdue elements (offsets reaching back before the phrase is)', () => {
    /** Play a phrase to its end at 120 bpm: each start's time, and when it ended. */
    async function played(data) {
      const inst = new Recorder();
      const t0 = Date.now();
      const start = inst.startNote.bind(inst);
      inst.startNote = (pitch, duration, velocity) => {
        start(pitch, duration, velocity);
        inst.started[inst.started.length - 1].at = Date.now() - t0;
      };
      const events = [];
      inst.noteCallback = (event) => events.push(event.pitch);
      let endedAt = null;
      const done = inst.play({ data, tempo: 120, basis: 4 }).then(() => {
        endedAt = Date.now() - t0;
      });
      await jest.advanceTimersByTimeAsync(10000);
      await done;
      return {
        starts: inst.started.map(({ pitch, duration, at }) => [pitch, duration, at]),
        events,
        endedAt,
        inst,
      };
    }

    it('a phrase drawn back whole sounds what is left of its first note and ends that much sooner', async () => {
      const { starts, endedAt } = await played(
        THREE_NOTES.map((note) => ({ ...note, offset: -100 })),
      );
      expect(starts).toEqual([
        ['C/4', 400, 0],
        ['D/4', 500, 400],
        ['E/4', 500, 900],
      ]);
      expect(endedAt).toBe(1400);
    });

    it('a one-note phrase drawn back ends on the time it was due to (nothing after it to draw back)', async () => {
      const { starts, endedAt, inst } = await played([{ pitch: 'B/5', length: '1/1', offset: -300 }]);
      expect(starts).toEqual([['B/5', 1700, 0]]);
      expect(endedAt).toBe(1700);
      expect(inst.playbackState.isPlaying).toBe(false);
    });

    it('a chord drawn back shortens every member by as much', async () => {
      const { starts, endedAt } = await played([
        [
          { pitch: 'C/4', length: '1/2', offset: -100 },
          { pitch: 'E/4', length: '1/4', offset: -100 },
        ],
      ]);
      expect(starts).toEqual([
        ['C/4', 900, 0],
        ['E/4', 400, 0],
      ]);
      expect(endedAt).toBe(400); // a chord lasts its shortest member
    });

    it('the elements after an overdue one keep their own times', async () => {
      const { starts, endedAt } = await played([
        { pitch: 'C/4', length: '1/4', offset: -100 },
        { pitch: 'D/4', length: '1/4' },
      ]);
      expect(starts).toEqual([
        ['C/4', 400, 0],
        ['D/4', 500, 500],
      ]);
      expect(endedAt).toBe(1000);
    });

    it('a note overdue by its whole length is neither struck nor reported', async () => {
      const { starts, events, endedAt } = await played([
        { pitch: 'C/4', length: '1/4', offset: -600 },
        { pitch: 'D/4', length: '1/4' },
      ]);
      expect(starts).toEqual([['D/4', 500, 500]]);
      expect(events).toEqual(['D/4']);
      expect(endedAt).toBe(1000);
    });

    it('offsets that reach nothing overdue time the phrase as before', async () => {
      const { starts, endedAt } = await played([
        { pitch: 'C/4', length: '1/4' },
        { pitch: 'D/4', length: '1/4', offset: -100 },
        { pitch: 'E/4', length: '1/4', offset: -100 },
      ]);
      expect(starts).toEqual([
        ['C/4', 500, 0],
        ['D/4', 500, 400],
        ['E/4', 500, 900],
      ]);
      expect(endedAt).toBe(1400);
    });
  });
});
