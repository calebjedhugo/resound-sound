import { getFrequency } from './noteFrequencies';

// Pitch → Hz is the bottom of every instrument: get it wrong and a note sounds
// confidently at the wrong pitch, which no other test would catch.
describe('getFrequency', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes a raw frequency through untouched', () => {
    expect(getFrequency(432)).toBe(432);
  });

  it('reads the measured table for the range it covers', () => {
    expect(getFrequency('A/4')).toBe(440);
    expect(getFrequency('C/4')).toBe(261.626);
  });

  it('accepts the no-slash shorthand and resolves it to the same value', () => {
    expect(getFrequency('A4')).toBe(getFrequency('A/4'));
    expect(getFrequency('C#4')).toBe(getFrequency('C#/4'));
  });

  it('computes pitches above the table instead of collapsing them to A4', () => {
    // A descant sitting above B/5 used to sound A4 — every note the same.
    expect(getFrequency('C/6')).toBeCloseTo(1046.5, 1);
    expect(getFrequency('A/6')).toBeCloseTo(1760, 6);
    expect(getFrequency('C/6')).not.toBe(440);
  });

  it('computes pitches below the table', () => {
    expect(getFrequency('A/1')).toBeCloseTo(55, 6);
    expect(getFrequency('E/1')).toBeCloseTo(41.2, 1);
  });

  it('applies accidentals outside the table', () => {
    expect(getFrequency('F#/6')).toBeCloseTo(1479.98, 1);
    expect(getFrequency('Bb/6')).toBeCloseTo(1864.66, 1);
    // ...and the same spelling one octave down still matches the table.
    expect(getFrequency('Bb/5')).toBe(932.33);
    // A sharp sits one semitone above its natural.
    expect(getFrequency('G#/6') / getFrequency('G/6')).toBeCloseTo(2 ** (1 / 12), 6);
  });

  it('falls back to A4 with a warning for something it cannot parse', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getFrequency('not-a-pitch')).toBe(440);
    expect(getFrequency(undefined)).toBe(440); // never throws on bad input
    // A plain table lookup would return Object.prototype.constructor here.
    expect(getFrequency('constructor')).toBe(440);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
