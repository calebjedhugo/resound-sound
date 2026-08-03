import Sequencer from './Sequencer';

// Schema-native multi-voice playback (SPEC-schema-playback.md). A stub
// instrument records startNote() calls so timing, mute, loop and velocity are
// asserted without any Web Audio.
class StubInstrument {
  constructor(id = 'stub') {
    this.id = id;
    this.calls = [];
    this.stopAllCalls = 0;
    this.warmed = null;
  }

  startNote(pitch, duration, velocity) {
    this.calls.push({ pitch, duration, velocity });
  }

  stopAll() {
    this.stopAllCalls += 1;
  }

  async warm(pitches) {
    this.warmed = pitches;
  }
}

describe('Sequencer', () => {
  const TICK = 25;
  let t;
  let live;

  beforeEach(() => {
    t = 0;
    live = [];
  });

  afterEach(() => {
    live.forEach((s) => s.pause());
    live = [];
  });

  function makeSeq(options = {}) {
    const seq = new Sequencer({ now: () => t, ...options });
    live.push(seq);
    return seq;
  }

  /** Advance wall-clock time in tick-sized steps, running the tick loop. */
  function step(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK) {
      t += TICK;
      jest.advanceTimersByTime(TICK);
    }
  }

  const SCALE = {
    tempo: 120, // one quarter-note beat = 500ms
    voices: [{
      id: 'soprano',
      notes: [
        { pitch: 'C4', length: '1/4' },
        { pitch: 'D4', length: '1/4' },
        { pitch: 'E4', length: '1/2' },
      ],
    }],
  };

  const SATB = {
    tempo: 120,
    voices: [
      { id: 'soprano', notes: [{ pitch: 'C5', length: '1/4' }, { pitch: 'D5', length: '1/4' }] },
      { id: 'bass', notes: [{ pitch: 'C3', length: '1/4' }, { pitch: 'G2', length: '1/4' }] },
    ],
  };

  it('exposes the loaded song state', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.load(SCALE);

    expect(seq.totalBeats).toBe(4);
    expect(seq.beat).toBe(0);
    expect(seq.playing).toBe(false);
    expect(seq.pitches()).toEqual(['C4', 'D4', 'E4']);
  });

  it('parks at the first sounding onset, not on leading rests', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.load({ tempo: 120, voices: [{ id: 'v', notes: [{ length: '1/2' }, { pitch: 'C4', length: '1/4' }] }] });

    expect(seq.startBeat).toBe(2);
    expect(seq.beat).toBe(2);
  });

  it('fires notes at their beat with tempo-correct durations', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);

    expect(piano.calls).toEqual([{ pitch: 'C4', duration: 500, velocity: undefined }]);

    step(500);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'D4']);

    step(500);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'D4', 'E4']);
    expect(piano.calls[2].duration).toBe(1000);
  });

  it('plays every voice off one shared clock', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SATB);

    expect(piano.calls.map((c) => c.pitch).sort()).toEqual(['C3', 'C5']);
    step(500);
    expect(piano.calls.map((c) => c.pitch).sort()).toEqual(['C3', 'C5', 'D5', 'G2']);
  });

  it('routes voices to their own instruments when given a map', () => {
    const upper = new StubInstrument('upper');
    const lower = new StubInstrument('lower');
    const seq = makeSeq({ instrument: upper, instruments: { bass: lower } });
    seq.play(SATB);

    expect(upper.calls.map((c) => c.pitch)).toEqual(['C5']);
    expect(lower.calls.map((c) => c.pitch)).toEqual(['C3']);
  });

  it('stretches note spacing through a tempoMap multiplier', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play({ ...SCALE, tempoMap: [{ beat: 1, multiplier: 0.5 }] });

    step(500); // beat 1 reached at full tempo
    expect(piano.calls).toHaveLength(2);

    step(500); // half speed: only half a beat covered, E4 (beat 2) not yet due
    expect(piano.calls).toHaveLength(2);

    step(500);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'D4', 'E4']);
  });

  it('applies setTempo from the next tick without restarting', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);
    seq.setTempo(240); // twice as fast: a beat is now 250ms

    step(250);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'D4']);
    expect(piano.calls[1].duration).toBe(250);
    expect(seq.beat).toBeCloseTo(1, 6);
  });

  it('pauses in place and resumes from the same beat', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);
    step(300);
    seq.pause();
    const held = seq.beat;

    expect(seq.playing).toBe(false);
    expect(piano.stopAllCalls).toBe(1);
    step(1000); // time passes while paused
    expect(piano.calls).toHaveLength(1);
    expect(seq.beat).toBe(held);

    seq.play();
    step(300);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'D4']);
  });

  it('seeks forward past notes and back over them', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);
    seq.seek(2);
    step(25);

    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'E4']);

    seq.seek(1);
    step(25);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'E4', 'D4']);
  });

  it('clamps a seek to the song', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.load(SCALE);
    seq.seek(-5);
    expect(seq.beat).toBe(0);
    seq.seek(99);
    expect(seq.beat).toBe(4);
  });

  it('silences muted voices and revives them on unmute', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.load(SATB);
    seq.mute('bass');
    seq.play();

    expect(piano.calls.map((c) => c.pitch)).toEqual(['C5']);

    seq.unmute('bass');
    step(500);
    expect(piano.calls.map((c) => c.pitch).sort()).toEqual(['C5', 'D5', 'G2']);
  });

  it('toggles and sets mutes in bulk', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.load(SATB);

    expect(seq.toggleMute('bass')).toBe(false); // returns the new sounding state
    expect(seq.isMuted('bass')).toBe(true);
    expect(seq.toggleMute('bass')).toBe(true);

    seq.setMuted(['soprano', 'bass']);
    expect(seq.isMuted('soprano')).toBe(true);
    seq.setMuted([]);
    expect(seq.isMuted('soprano')).toBe(false);
  });

  it('wraps an A-B loop and re-attacks the range', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.load(SCALE);
    seq.setLoop(0, 1);
    seq.play();

    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4']);
    step(500);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'C4']);
    expect(seq.beat).toBeLessThan(1);

    step(500);
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4', 'C4', 'C4']);
    expect(piano.calls.every((c) => c.pitch === 'C4')).toBe(true);
  });

  it('clears a loop given a non-positive range', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.load(SCALE);
    seq.setLoop(2, 1);
    expect(seq.looping).toBe(false);
    seq.setLoop(1, 3);
    expect(seq.looping).toBe(true);
    seq.clearLoop();
    expect(seq.looping).toBe(false);
    expect(seq.loopStart).toBeNull();
  });

  it('reports position through onTick and finishes once through onEnd', () => {
    const piano = new StubInstrument();
    const ticks = [];
    const seq = makeSeq({ instrument: piano });
    seq.onTick = (beat) => ticks.push(beat);
    seq.onEnd = jest.fn();
    seq.play(SCALE);

    step(250);
    expect(ticks[ticks.length - 1]).toBeCloseTo(0.5, 6);
    expect(seq.onEnd).not.toHaveBeenCalled();

    step(2000);
    expect(seq.onEnd).toHaveBeenCalledTimes(1);
    expect(seq.playing).toBe(false);
  });

  it('never ends while looping', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.onEnd = jest.fn();
    seq.load(SCALE);
    seq.setLoop(0, 2);
    seq.play();
    step(4000);

    expect(seq.onEnd).not.toHaveBeenCalled();
    expect(seq.playing).toBe(true);
  });

  it('keeps the cursor running for tailBeats past the last note', () => {
    const seq = makeSeq({ instrument: new StubInstrument(), tailBeats: 2 });
    seq.onEnd = jest.fn();
    seq.play(SCALE);

    step(2100); // past totalBeats (4 beats = 2000ms), inside the tail
    expect(seq.onEnd).not.toHaveBeenCalled();

    step(1000);
    expect(seq.onEnd).toHaveBeenCalledTimes(1);
  });

  it('asks the velocity callback per note and passes the answer to startNote', () => {
    const piano = new StubInstrument();
    const seen = [];
    const seq = makeSeq({
      instrument: piano,
      velocity: (ctx) => {
        seen.push(ctx);
        return [0.95, 0.8][ctx.activeVoices - 1];
      },
    });
    seq.load(SATB);
    seq.play();

    expect(piano.calls.every((c) => c.velocity === 0.8)).toBe(true);
    expect(seen[0]).toMatchObject({ voiceId: 'soprano', beat: 0, activeVoices: 2, voiceCount: 2 });

    seq.mute('bass');
    step(500);
    expect(piano.calls[piano.calls.length - 1].velocity).toBe(0.95);
  });

  it('takes a constant velocity option, and lets a note override it', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano, velocity: 0.4 });
    seq.play({
      tempo: 120,
      voices: [{ id: 'v', notes: [{ pitch: 'C4', length: '1/4' }, { pitch: 'D4', length: '1/4', velocity: 0.9 }] }],
    });

    expect(piano.calls[0].velocity).toBe(0.4);
    step(500);
    expect(piano.calls[1].velocity).toBe(0.9);
  });

  it('warms every pitch in the song through the instrument', async () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.load(SCALE);
    await seq.warm();

    expect(piano.warmed).toEqual(['C4', 'D4', 'E4']);
  });

  it('stop() returns to the start and silences the instrument', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);
    step(600);
    seq.stop();

    expect(seq.playing).toBe(false);
    expect(seq.beat).toBe(seq.startBeat);
    expect(piano.stopAllCalls).toBe(1);
  });

  it('restarts from the beginning when played out at the end', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);
    step(2500); // run to the end
    expect(seq.playing).toBe(false);

    piano.calls.length = 0;
    seq.play();
    expect(piano.calls.map((c) => c.pitch)).toEqual(['C4']);
  });

  it('ignores play() while already playing', () => {
    const piano = new StubInstrument();
    const seq = makeSeq({ instrument: piano });
    seq.play(SCALE);
    seq.play();
    seq.play();

    expect(piano.calls).toHaveLength(1);
  });

  it('survives a song with no notes', () => {
    const seq = makeSeq({ instrument: new StubInstrument() });
    seq.onEnd = jest.fn();
    seq.play({ tempo: 120, voices: [] });
    step(200);

    expect(seq.totalBeats).toBe(0);
    expect(seq.onEnd).toHaveBeenCalled();
  });
});
