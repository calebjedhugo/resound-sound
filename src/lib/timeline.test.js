import { buildTimeline } from './timeline';

// Schema-native playback (SPEC-schema-playback.md): the timeline pass turns the
// shared note schema — the very arrays resound-notation renders — into sounding
// events on the notated-beat timeline. No audio involved.
describe('buildTimeline', () => {
  const voice = (notes, id = 'v') => ({ voices: [{ id, notes }] });

  it('places plain notes at their cumulative beat', () => {
    const { events, totalBeats } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4' },
      { pitch: 'D4', length: '1/2' },
      { pitch: 'E4', length: '1/4' },
    ]));

    expect(events.map((e) => [e.pitch, e.beat, e.durationBeats])).toEqual([
      ['C4', 0, 1],
      ['D4', 1, 2],
      ['E4', 3, 1],
    ]);
    expect(totalBeats).toBe(4);
  });

  it('gives dotted notes 1.5x their face value', () => {
    const { events, totalBeats } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4', dotted: true },
      { pitch: 'D4', length: '1/8' },
    ]));

    expect(events[0].durationBeats).toBe(1.5);
    expect(events[1].beat).toBe(1.5);
    expect(totalBeats).toBe(2);
  });

  it('advances past rests without sounding them', () => {
    const { events, totalBeats } = buildTimeline(voice([
      { length: '1/2' },
      { pitch: 'C4', length: '1/4' },
    ]));

    expect(events).toHaveLength(1);
    expect(events[0].beat).toBe(2);
    expect(totalBeats).toBe(3);
  });

  it('scales beats by basis', () => {
    const { events, totalBeats } = buildTimeline({
      basis: 2,
      voices: [{ id: 'v', notes: [{ pitch: 'C4', length: '1/4' }, { pitch: 'D4', length: '1/4' }] }],
    });

    expect(events.map((e) => e.beat)).toEqual([0, 0.5]);
    expect(totalBeats).toBe(1);
  });

  it('merges a tie pair into one event of summed duration', () => {
    const { events } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { pitch: 'C4', length: '1/4', tie: 'stop' },
      { pitch: 'D4', length: '1/4' },
    ]));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ pitch: 'C4', beat: 0, durationBeats: 2 });
    expect(events[1]).toMatchObject({ pitch: 'D4', beat: 2 });
  });

  it('merges a three-note tie chain through continue', () => {
    const { events } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { pitch: 'C4', length: '1/4', tie: 'continue' },
      { pitch: 'C4', length: '1/4', dotted: true, tie: 'stop' },
    ]));

    expect(events).toHaveLength(1);
    expect(events[0].durationBeats).toBe(3.5);
  });

  it('sounds a tie stop whose pitch does not match the open note', () => {
    const { events } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { pitch: 'E4', length: '1/4', tie: 'stop' },
    ]));

    expect(events).toHaveLength(2);
    expect(events[0].durationBeats).toBe(1);
    expect(events[1]).toMatchObject({ pitch: 'E4', beat: 1, durationBeats: 1 });
  });

  it('sounds an orphan tie stop as an ordinary note', () => {
    const { events } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4' },
      { pitch: 'C4', length: '1/4', tie: 'stop' },
    ]));

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ beat: 1, durationBeats: 1 });
  });

  it('does not merge across an intervening rest', () => {
    const { events } = buildTimeline(voice([
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { length: '1/4' },
      { pitch: 'C4', length: '1/4', tie: 'stop' },
    ]));

    expect(events).toHaveLength(2);
    expect(events[0].durationBeats).toBe(1);
    expect(events[1].beat).toBe(2);
  });

  it('sounds every chord member and advances by the first', () => {
    const { events, totalBeats } = buildTimeline(voice([
      [
        { pitch: 'C4', length: '1/4' },
        { pitch: 'E4', length: '1/4' },
        { pitch: 'G4', length: '1/2' },
      ],
      { pitch: 'F4', length: '1/4' },
    ]));

    expect(events.filter((e) => e.beat === 0).map((e) => e.pitch)).toEqual(['C4', 'E4', 'G4']);
    expect(events.find((e) => e.pitch === 'G4').durationBeats).toBe(2);
    expect(events.find((e) => e.pitch === 'F4').beat).toBe(1);
    expect(totalBeats).toBe(2);
  });

  it('ties one chord member while its neighbours re-attack', () => {
    const { events } = buildTimeline(voice([
      [
        { pitch: 'C4', length: '1/4', tie: 'start' },
        { pitch: 'E4', length: '1/4' },
      ],
      [
        { pitch: 'C4', length: '1/4', tie: 'stop' },
        { pitch: 'E4', length: '1/4' },
      ],
    ]));

    const c4 = events.filter((e) => e.pitch === 'C4');
    const e4 = events.filter((e) => e.pitch === 'E4');
    expect(c4).toHaveLength(1);
    expect(c4[0].durationBeats).toBe(2);
    expect(e4.map((e) => e.beat)).toEqual([0, 1]);
  });

  it('keeps voices on one shared timeline and reports the longest as total', () => {
    const { events, totalBeats } = buildTimeline({
      voices: [
        { id: 'soprano', notes: [{ pitch: 'C5', length: '1/2' }] },
        { id: 'bass', notes: [{ pitch: 'C3', length: '1/4' }, { pitch: 'G2', length: '1/4' }, { pitch: 'C3', length: '1/4' }] },
      ],
    });

    expect(events.map((e) => [e.voiceId, e.beat])).toEqual([
      ['soprano', 0],
      ['bass', 0],
      ['bass', 1],
      ['bass', 2],
    ]);
    expect(totalBeats).toBe(3);
  });

  it('defaults a voice id to its index', () => {
    const { events } = buildTimeline({ voices: [{ notes: [{ pitch: 'C4', length: '1/4' }] }] });
    expect(events[0].voiceId).toBe(0);
  });

  it('ignores unknown note fields and zero-beat markers', () => {
    const { events, totalBeats } = buildTimeline(voice([
      { barline: 'double' },
      { pitch: 'C4', length: '1/4', lyric: ['A-', 'maz-'], clef: 'treble' },
      { dynamic: 'mf' },
    ]));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ pitch: 'C4', beat: 0 });
    expect(totalBeats).toBe(1);
  });

  it('carries a note-level velocity onto the event', () => {
    const { events } = buildTimeline(voice([{ pitch: 'C4', length: '1/4', velocity: 0.3 }]));
    expect(events[0].velocity).toBe(0.3);
  });

  it('lists unique pitches for warming', () => {
    const { pitches } = buildTimeline({
      voices: [
        { id: 'a', notes: [{ pitch: 'C4', length: '1/4' }, { pitch: 'C4', length: '1/4' }] },
        { id: 'b', notes: [{ pitch: 'G3', length: '1/2' }] },
      ],
    });

    expect(pitches).toEqual(['C4', 'G3']);
  });

  it('handles an empty song', () => {
    expect(buildTimeline()).toEqual({ events: [], totalBeats: 0, pitches: [] });
    expect(buildTimeline({ voices: [] }).totalBeats).toBe(0);
  });
});
