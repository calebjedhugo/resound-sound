/**
 * Theremin: a theremin with electric crackle. Read off what each note
 * schedules on the (mocked) Web Audio nodes: the oscillator's pitch, the
 * envelope's loudness, the vibrato's depth and the crackle gate. The sound
 * itself is checked in a browser (OfflineAudioContext renders; CHANGELOG).
 */
import Theremin, { crackleSpikes } from './Theremin';
import audioContextManager from '../lib/AudioContextManager';
import { getFrequency } from '../lib/noteFrequencies';

const { DEFAULT_VOICE } = Theremin;
const context = audioContextManager.getContext();

/** A seeded random, so a test sees the same jitter and crackle every run. */
const seeded = (seed) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
};

/** A theremin, and every node it builds, in the order built. */
function watched(options = {}) {
  const built = {
    oscillators: [], gains: [], sources: [], filters: [],
  };
  const watch = (method, list) => {
    const create = context[method].bind(context);
    jest.spyOn(context, method).mockImplementation((...args) => {
      const node = create(...args);
      built[list].push(node);
      return node;
    });
  };
  watch('createOscillator', 'oscillators');
  watch('createGain', 'gains');
  watch('createBufferSource', 'sources');
  watch('createBiquadFilter', 'filters');
  const theremin = new Theremin('test', options);
  return { theremin, built };
}

/** A line's nodes, from what its theremin built: [oscillator, lfo] per line. */
const lineNodes = (built, line = 0) => ({
  pitch: built.oscillators[2 * line].frequency,
  lfo: built.oscillators[2 * line + 1].frequency,
});

/** The calls a mocked AudioParam method got, as [value, time, ...]. */
const calls = (fn) => fn.mock.calls;

beforeEach(() => {
  context.currentTime = 0;
});

afterEach(() => jest.restoreAllMocks());

describe('A theremin voice', () => {
  it('defaults to the middle of the creature ranges, takes given values, and clamps them', () => {
    expect(new Theremin().getVoice()).toEqual(DEFAULT_VOICE);
    expect(new Theremin('a', { vibratoRate: 5.1, spark: 0 }).getVoice()).toEqual({
      ...DEFAULT_VOICE, vibratoRate: 5.1, spark: 0,
    });
    const odd = new Theremin('a', { vibratoDepth: 900, attack: -1, glide: NaN, warmth: 1.13 });
    expect(odd.getVoice().vibratoDepth).toBe(Theremin.VOICE_LIMITS.vibratoDepth[1]);
    expect(odd.getVoice().attack).toBe(Theremin.VOICE_LIMITS.attack[0]);
    expect(odd.getVoice().glide).toBe(DEFAULT_VOICE.glide); // not a number: the default
    expect(odd.getVoice().warmth).toBeCloseTo(1.15, 10); // on its grid (wavetables are shared)
  });

  it('setVoice changes only what it is given', () => {
    const theremin = new Theremin('a', { spark: 0.5 });
    theremin.setVoice({ vibratoRate: 6, waveform: 'square' });
    expect(theremin.getVoice()).toEqual({ ...DEFAULT_VOICE, spark: 0.5, vibratoRate: 6 });
  });

  it('starts a note on its onset, softly, from silence', () => {
    const { theremin, built } = watched();
    const t0 = 1;

    theremin.startNote('A4', 500, undefined, t0);

    const [, , envelope] = built.gains; // volume, then the line's depth, envelope, gate
    expect(calls(envelope.gain.setValueAtTime)[0]).toEqual([0, t0]);
    const [peak, peakAt] = calls(envelope.gain.linearRampToValueAtTime)[0];
    expect(peak).toBeGreaterThan(0);
    expect(peakAt - t0).toBeCloseTo(DEFAULT_VOICE.attack, 5);
    // The release ends 40 ms after the notated end
    const ramps = calls(envelope.gain.linearRampToValueAtTime);
    expect(ramps[ramps.length - 1][0]).toBe(0);
    expect(ramps[ramps.length - 1][1]).toBeCloseTo(t0 + 0.54, 5);
  });

  it('lands each note on its pitch quickly: a small scoop from silence, a glide from the note before', () => {
    const { theremin, built } = watched();
    const t0 = 1;
    const a4 = getFrequency('A4');
    const c5 = getFrequency('C5');

    theremin.startNote('A4', 500, undefined, t0);
    theremin.startNote('C5', 500, undefined, t0 + 0.5);

    expect(built.oscillators).toHaveLength(2); // one line: its oscillator and vibrato
    const { pitch } = lineNodes(built);
    const [scoopFrom, scoopAt] = calls(pitch.setValueAtTime)[0];
    expect(scoopAt).toBe(t0);
    expect(1200 * Math.log2(a4 / scoopFrom)).toBeCloseTo(20, 5); // 20 cents below
    // The glide to C5 starts on its onset and locks onto the pitch within 80 ms
    expect(calls(pitch.setTargetAtTime)[1]).toEqual([c5, t0 + 0.5, DEFAULT_VOICE.glide]);
    const [locked, lockedAt] = calls(pitch.setValueAtTime).slice(-1)[0];
    expect(locked).toBe(c5);
    expect(lockedAt - (t0 + 0.5)).toBeLessThan(0.08);
  });

  it('re-articulates a repeated pitch with a deeper dip than a moving one', () => {
    const { theremin, built } = watched();
    const t0 = 1;
    theremin.startNote('A4', 500, undefined, t0);
    theremin.startNote('A4', 500, undefined, t0 + 0.5);
    theremin.startNote('C5', 500, undefined, t0 + 1);
    const envelope = built.gains[2].gain;
    const dipTo = (onset) => calls(envelope.linearRampToValueAtTime).find(
      ([, at]) => Math.abs(at - onset - 0.008) < 1e-9,
    )[0];
    expect(dipTo(t0 + 0.5)).toBeLessThan(dipTo(t0 + 1) / 2);
  });

  it('develops its vibrato after the onset, at about 5-6 Hz', () => {
    const { theremin, built } = watched();
    const t0 = 1;
    theremin.startNote('A4', 1000, undefined, t0);

    const depth = built.gains[1].gain;
    expect(calls(depth.setValueAtTime)[0]).toEqual([0, t0]); // none at the onset
    const [cents, fullAt] = calls(depth.linearRampToValueAtTime).slice(-1)[0];
    expect(cents).toBeGreaterThan(DEFAULT_VOICE.vibratoDepth * 0.8);
    expect(cents).toBeLessThan(DEFAULT_VOICE.vibratoDepth * 1.2);
    expect(fullAt - t0).toBeCloseTo(0.51, 5); // 160 ms still, then a 350 ms swell
    const [rate] = calls(lineNodes(built).lfo.setValueAtTime)[0];
    expect(rate).toBeGreaterThan(5);
    expect(rate).toBeLessThan(6);
  });

  it('gives each member of a chord a line of its own', () => {
    const { theremin, built } = watched();
    ['C4', 'E4', 'G4'].forEach((pitch) => theremin.startNote(pitch, 500, undefined, 1));
    expect(built.oscillators).toHaveLength(6);
    expect(built.sources).toHaveLength(3); // a crackle noise each
  });

  it('keeps a line across a short rest, and starts a new one after a long one', () => {
    const { theremin, built } = watched();
    const t0 = 1;
    theremin.startNote('C4', 250, undefined, t0);
    theremin.startNote('D4', 250, undefined, t0 + 1); // a 750 ms rest
    expect(built.oscillators).toHaveLength(2);
    theremin.startNote('E4', 250, undefined, t0 + 4); // a 2.75 s rest
    expect(built.oscillators).toHaveLength(4);
  });

  it('builds a song ahead: its notes then build nothing', () => {
    const { theremin, built } = watched();
    const song = [
      { pitch: 'C4', length: '1/4' },
      [
        { pitch: 'E4', length: '1/4' },
        { pitch: 'G4', length: '1/4' },
      ],
    ];
    theremin.warm();
    expect(theremin.isWarm()).toBe(true);
    theremin.prepare(song, 120);
    expect(theremin.isPrepared(song, 120)).toBe(true);
    const count = () => Object.values(built).reduce((sum, list) => sum + list.length, 0);
    const before = count();

    theremin.startNote('C4', 500, undefined, 1);
    theremin.startNote('E4', 500, undefined, 1.5);
    theremin.startNote('G4', 500, undefined, 1.5);

    expect(count()).toBe(before);
  });

  it('follows its volume on one gain into the master output, and fades out on a stop', () => {
    const { theremin, built } = watched();
    theremin.startNote('A4', 500);
    const [volume] = built.gains;
    expect(volume.outputs).toEqual([audioContextManager.getOutput()]);
    theremin.updateVolume(0.25);
    expect(calls(volume.gain.setTargetAtTime).slice(-1)[0][0]).toBe(0.25);

    theremin.stop();
    expect(calls(volume.gain.linearRampToValueAtTime).slice(-1)[0][0]).toBe(0);
  });

  it('plays into an output it is given (an offline render)', () => {
    const offline = new OfflineAudioContext(1, 44100, 44100);
    const theremin = new Theremin('t', { context: offline, output: offline.destination });
    theremin.startNote('A4', 500, undefined, 0);
    expect(offline.destination.inputs).toHaveLength(1);
  });
});

describe('Theremin crackle', () => {
  it('cracks on every attack, early, then crackles sparsely while the note holds', () => {
    let held = 0;
    let seconds = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const spikes = crackleSpikes(0, 2, 1, seeded(seed));
      expect(spikes[0].t).toBeLessThan(0.013);
      spikes.forEach((spike, i) => {
        if (i > 0) expect(spike.t).toBeGreaterThan(spikes[i - 1].t + spikes[i - 1].len);
        expect(spike.amp).toBeGreaterThan(0);
      });
      held += spikes.filter((spike) => spike.t > 0.2).length;
      seconds += 1.8;
    }
    const perSecond = held / seconds;
    expect(perSecond).toBeGreaterThan(2);
    expect(perSecond).toBeLessThan(5.5);
  });

  it('crackle: false builds none of it, and the tone is the same as with spark 0', () => {
    const phrase = (theremin) => {
      theremin.startNote('A4', 500, undefined, 1);
      theremin.startNote('C5', 400, undefined, 1.5);
      ['E4', 'G4'].forEach((pitch) => theremin.startNote(pitch, 600, undefined, 2));
    };
    const off = watched({ crackle: false, random: seeded(7) });
    phrase(off.theremin);
    expect(off.built.sources).toHaveLength(0);
    expect(off.built.filters).toHaveLength(0);
    jest.restoreAllMocks();

    const spark0 = watched({ spark: 0, random: seeded(7) });
    phrase(spark0.theremin);

    const automation = (built) => [
      ...built.oscillators.map((osc) => calls(osc.frequency.setValueAtTime)),
      ...built.oscillators.map((osc) => calls(osc.frequency.setTargetAtTime)),
    ];
    expect(automation(off.built)).toEqual(automation(spark0.built));
    // ...the gains (no crackle gates) likewise
    const gates = new Set(spark0.built.filters.flatMap((filter) => filter.inputs));
    const toneGains = (built) => built.gains
      .filter((gain) => !gates.has(gain))
      .map((gain) => calls(gain.gain.linearRampToValueAtTime));
    expect(toneGains(off.built)).toEqual(toneGains(spark0.built));
  });

  it('without crackle, warming builds only the wavetable (no noise)', () => {
    Theremin.forgetSharedAudio(context);
    const createBuffer = jest.spyOn(context, 'createBuffer');
    const theremin = new Theremin('t', { crackle: false });
    expect(theremin.isWarm()).toBe(false);
    theremin.warm();
    expect(theremin.isWarm()).toBe(true);
    expect(createBuffer).not.toHaveBeenCalled();
    expect(new Theremin('u').isWarm()).toBe(false); // one with crackle still needs its noise
  });
});

describe('Theremin.play: dots and ties', () => {
  /** Play a phrase to its end at 60 bpm (a quarter = 1 s): starts and events. */
  async function played(data, options = {}) {
    const theremin = new Theremin('t', options);
    const starts = [];
    const start = theremin.startNote.bind(theremin);
    jest.spyOn(theremin, 'startNote').mockImplementation((pitch, ms, ...rest) => {
      starts.push({ pitch, ms, at: Date.now() });
      return start(pitch, ms, ...rest);
    });
    const events = [];
    theremin.noteCallback = (event) => events.push({ ...event, at: Date.now() });
    const t0 = Date.now();
    const done = theremin.play({ data, tempo: 60, basis: 4 });
    await jest.advanceTimersByTimeAsync(20000);
    await done;
    const rel = (list) => list.map((item) => ({ ...item, at: item.at - t0 }));
    return { starts: rel(starts), events: rel(events), theremin };
  }

  it('times dotted and double-dotted notes (x1.5, x1.75)', async () => {
    const { starts } = await played([
      { pitch: 'C4', length: '1/4', dotted: true },
      { pitch: 'D4', length: '1/4', dotted: 2 },
      { pitch: 'E4', length: '1/4', dotted: 1 },
      { pitch: 'F4', length: '1/16' },
    ]);
    expect(starts.map(({ pitch, ms, at }) => [pitch, ms, at])).toEqual([
      ['C4', 1500, 0],
      ['D4', 1750, 1500],
      ['E4', 1500, 3250],
      ['F4', 250, 4750],
    ]);
  });

  it('holds a tied note as one sound: struck once, for the whole run', async () => {
    const { starts, events } = await played([
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { pitch: 'C4', length: '1/8', dotted: true, tie: 'continue' },
      { pitch: 'C4', length: '1/16', tie: 'stop' },
      { pitch: 'D4', length: '1/4' },
    ]);
    expect(starts.map(({ pitch, ms, at }) => [pitch, ms, at])).toEqual([
      ['C4', 2000, 0],
      ['D4', 1000, 2000],
    ]);
    // One event for the run, carrying its length
    expect(events.map(({ pitch, length, tiedDuration }) => [pitch, length, tiedDuration])).toEqual([
      ['C4', '1/4', 2000],
      ['D4', '1/4', undefined],
    ]);
  });

  it('ties chord members each on their own: a held member, its neighbours struck again', async () => {
    const { starts, events } = await played([
      [
        { pitch: 'C4', length: '1/4', tie: 'start' },
        { pitch: 'E4', length: '1/4' },
        { pitch: 'G4', length: '1/4', dotted: 2, tie: 'start' },
      ],
      [
        { pitch: 'C4', length: '1/4', tie: 'stop' },
        { pitch: 'E4', length: '1/4' },
        { pitch: 'G4', length: '1/4', tie: 'stop' },
      ],
    ]);
    expect(starts.map(({ pitch, ms, at }) => [pitch, ms, at])).toEqual([
      ['C4', 2000, 0],
      ['E4', 1000, 0],
      ['G4', 2750, 0],
      ['E4', 1000, 1000],
    ]);
    expect(events.map((event) => event.pitch)).toEqual(['C4', 'E4', 'G4', 'E4']);
    expect(events[2]).toMatchObject({ dotted: 2, tie: 'start', tiedDuration: 2750, durationBeats: 2.75 });
    expect(events[1]).toMatchObject({ durationBeats: 1 });
    expect(events[1]).not.toHaveProperty('tiedDuration');
  });

  it('strikes a malformed tie (another pitch, or across a rest) as an ordinary note', async () => {
    const { starts } = await played([
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { pitch: 'D4', length: '1/4', tie: 'stop' },
      { pitch: 'E4', length: '1/4', tie: 'start' },
      { length: '1/4' },
      { pitch: 'E4', length: '1/4', tie: 'stop' },
    ]);
    expect(starts.map(({ pitch, ms }) => [pitch, ms])).toEqual([
      ['C4', 1000], ['D4', 1000], ['E4', 1000], ['E4', 1000],
    ]);
  });

  it("leaves the caller's notes as they were", async () => {
    const data = [
      { pitch: 'C4', length: '1/4', tie: 'start' },
      { pitch: 'C4', length: '1/4', tie: 'stop' },
    ];
    const copy = JSON.parse(JSON.stringify(data));
    await played(data);
    expect(data).toEqual(copy);
    expect(Object.getOwnPropertySymbols(data[0])).toHaveLength(0);
  });
});
