import Instrument from './Instrument';

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
});
