/**
 * Multi-voice playback of the shared note schema (SPEC-schema-playback.md).
 *
 * Plays the SAME untransformed voice arrays resound-notation renders, over one
 * beat clock, with the live controls a practice tool needs: pause/resume,
 * seek, tempo changes, per-voice mute and an A-B loop.
 *
 * Position is always in notated beats of `basis` (4 = quarter note), the same
 * timeline as resound-notation's data-beat attributes.
 *
 * The clock is a cursor, not a pre-scheduled Web Audio timeline: notes are
 * handed to the instrument as their onset is crossed, which is what lets mute,
 * tempo and seek take effect mid-phrase.
 */
import { buildTimeline } from './timeline';

const DEFAULT_TICK_MS = 25;
const PAUSE_FADE = 0.08;
const EPS = 1e-9;
// Onsets within a hair of the tick's end are fired now rather than a tick
// late — the beat cursor accumulates float error, and a 25ms straggle on a
// downbeat is audible.
const FIRE_SLOP = 1e-6;

const defaultNow = () => (
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
);

class Sequencer {
  /**
   * @param {Object} [options]
   * @param {Object} [options.instrument] - default sound source (needs startNote)
   * @param {Object} [options.instruments] - per-voice-id overrides
   * @param {number|Function} [options.velocity] - constant, or ({voiceId, activeVoices, ...}) => 0..1
   * @param {number} [options.tickMs=25] - clock resolution
   * @param {number} [options.tailBeats=0] - beats to keep the cursor running past the last note
   * @param {Function} [options.now] - time source in ms (injectable for tests)
   */
  constructor({
    instrument = null,
    instruments = null,
    velocity,
    tickMs = DEFAULT_TICK_MS,
    tailBeats = 0,
    now = defaultNow,
  } = {}) {
    this.instrument = instrument;
    this.instruments = instruments || {};
    this.velocityOption = velocity;
    this.tickMs = tickMs;
    this.tailBeats = tailBeats;
    this._now = now;

    this.song = null;
    this.events = [];
    this.totalBeats = 0;
    this.startBeat = 0;
    this.beat = 0;
    this.tempo = 120;
    this.basis = 4;
    this.tempoMap = [];
    this.voiceIds = [];
    this.muted = new Set();
    this.loopStart = null;
    this.loopEnd = null;
    this.playing = false;

    this.onTick = null; // (beat) => void
    this.onEnd = null; // () => void

    this._pitches = [];
    this._cursor = 0;
    this._timer = null;
    this._lastNow = 0;
  }

  /**
   * Load a song: the same object handed to NotationRenderer.render().
   * Extra keys (timeSignature, keySignature, pickupBeats, lyrics…) are ignored.
   * @param {Object} song - { voices, tempo, basis, tempoMap }
   */
  load(song) {
    this.pause();
    this.song = song || {};
    const { events, totalBeats, pitches } = buildTimeline(this.song);
    this.events = events;
    this.totalBeats = totalBeats;
    this._pitches = pitches;
    this.tempo = this.song.tempo || 120;
    this.basis = this.song.basis || 4;
    this.tempoMap = (this.song.tempoMap || []).slice().sort((a, b) => a.beat - b.beat);
    this.voiceIds = (this.song.voices || []).map((voice, i) => (voice.id !== undefined ? voice.id : i));
    this.startBeat = events.length ? events[0].beat : 0;
    this.beat = this.startBeat;
    this.clearLoop();
    this._cursor = this._indexAt(this.beat);
    return this;
  }

  /** Unique pitches in the loaded song (feed to warm()). */
  pitches() {
    return this._pitches;
  }

  /** Pre-render the song's pitches on every instrument that supports it. */
  async warm(pitches) {
    const list = pitches || this._pitches;
    if (!list.length) return;
    await Promise.all(this._allInstruments()
      .filter((instrument) => typeof instrument.warm === 'function')
      .map((instrument) => instrument.warm(list)));
  }

  /**
   * Start (or resume) playback. Pass a song to load it first.
   * @param {Object} [song]
   */
  play(song) {
    if (song) this.load(song);
    if (this.playing) return this;
    if (this.looping && (this.beat < this.loopStart || this.beat >= this.loopEnd - EPS)) {
      this.beat = this.loopStart;
    } else if (this.totalBeats > 0 && this.beat >= this.totalBeats - EPS) {
      this.beat = this.startBeat;
    }
    this.playing = true;
    this._lastNow = this._now();
    this._cursor = this._indexAt(this.beat);
    this._fireAt(this.beat); // notes sitting exactly on the cursor sound now
    this._schedule();
    return this;
  }

  /** Stop the clock where it stands, fading anything still ringing. */
  pause() {
    if (!this.playing) return this;
    this.playing = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._allInstruments().forEach((instrument) => {
      if (typeof instrument.stopAll === 'function') instrument.stopAll(PAUSE_FADE);
    });
    return this;
  }

  /** Pause and return to the first sounding onset. */
  stop() {
    this.pause();
    this.seek(this.startBeat);
    return this;
  }

  /**
   * Jump the cursor. Safe while playing.
   * @param {number} beat
   * @returns {number} the clamped beat
   */
  seek(beat) {
    this.beat = Math.max(0, Math.min(beat, this.totalBeats));
    this._cursor = this._indexAt(this.beat);
    if (this.onTick) this.onTick(this.beat);
    return this.beat;
  }

  /** Change tempo (BPM of the `basis` note). Takes effect on the next tick. */
  setTempo(bpm) {
    this.tempo = bpm;
    return this;
  }

  /** Seconds per beat at `beat`, including the tempoMap's rit/accel multiplier. */
  secondsPerBeat(beat) {
    return 60 / (this.tempo * this.tempoMultiplier(beat));
  }

  /** The tempoMap multiplier in force at `beat` (1 when none applies). */
  tempoMultiplier(beat) {
    let multiplier = 1;
    for (const entry of this.tempoMap) {
      if (beat >= entry.beat) multiplier = entry.multiplier;
      else break;
    }
    return multiplier;
  }

  mute(voiceId) {
    this.muted.add(voiceId);
    return this;
  }

  unmute(voiceId) {
    this.muted.delete(voiceId);
    return this;
  }

  /** @returns {boolean} whether the voice now SOUNDS (i.e. is unmuted) */
  toggleMute(voiceId) {
    if (this.muted.has(voiceId)) this.muted.delete(voiceId);
    else this.muted.add(voiceId);
    return !this.muted.has(voiceId);
  }

  setMuted(voiceIds) {
    this.muted = new Set(voiceIds || []);
    return this;
  }

  isMuted(voiceId) {
    return this.muted.has(voiceId);
  }

  /** A-B loop over [start, end). A non-positive range clears the loop. */
  setLoop(start, end) {
    if (start === null || start === undefined || end === null || end === undefined
      || end <= start + EPS) {
      return this.clearLoop();
    }
    this.loopStart = start;
    this.loopEnd = end;
    return this;
  }

  clearLoop() {
    this.loopStart = null;
    this.loopEnd = null;
    return this;
  }

  get looping() {
    return this.loopStart !== null && this.loopEnd !== null && this.loopEnd > this.loopStart;
  }

  // ---------- internals ----------

  _allInstruments() {
    return [...new Set([this.instrument, ...Object.values(this.instruments)].filter(Boolean))];
  }

  _schedule() {
    this._timer = setTimeout(() => this._tick(), this.tickMs);
  }

  _tick() {
    this._timer = null;
    if (!this.playing) return;
    const now = this._now();
    const dt = (now - this._lastNow) / 1000;
    this._lastNow = now;

    const from = this.beat;
    let to = from + dt / this.secondsPerBeat(from);
    const wrapping = this.looping && from < this.loopEnd && to >= this.loopEnd - EPS;

    if (wrapping) {
      this._fire(this.loopEnd, -EPS); // the loop end itself belongs to the next pass
      to = this.loopStart;
      this.beat = to;
      this._cursor = this._indexAt(to);
      this._fireAt(to);
    } else {
      this._fire(to, FIRE_SLOP);
      this.beat = to;
    }

    if (this.onTick) this.onTick(this.beat);

    if (!this.looping && this.beat >= this.totalBeats + this.tailBeats - EPS) {
      this.playing = false;
      this.beat = this.startBeat;
      this._cursor = this._indexAt(this.beat);
      if (this.onEnd) this.onEnd();
      return;
    }
    this._schedule();
  }

  /** Sound every pending event before `until` (+ slop). */
  _fire(until, slop) {
    while (this._cursor < this.events.length
      && this.events[this._cursor].beat < until + slop) {
      this._sound(this.events[this._cursor]);
      this._cursor += 1;
    }
  }

  /** Sound every pending event sitting exactly on `beat`. */
  _fireAt(beat) {
    while (this._cursor < this.events.length
      && this.events[this._cursor].beat <= beat + FIRE_SLOP) {
      this._sound(this.events[this._cursor]);
      this._cursor += 1;
    }
  }

  _sound(event) {
    if (this.muted.has(event.voiceId)) return;
    const instrument = this.instruments[event.voiceId] || this.instrument;
    if (!instrument) return;
    const ms = event.durationBeats * this.secondsPerBeat(event.beat) * 1000;
    instrument.startNote(event.pitch, ms, this._velocityFor(event));
  }

  _velocityFor(event) {
    if (event.velocity !== undefined) return event.velocity;
    if (typeof this.velocityOption !== 'function') return this.velocityOption;
    return this.velocityOption({
      note: event.note,
      voiceId: event.voiceId,
      beat: event.beat,
      durationBeats: event.durationBeats,
      activeVoices: this.voiceIds.filter((id) => !this.muted.has(id)).length,
      voiceCount: this.voiceIds.length,
      muted: this.muted,
    });
  }

  /** First event index at or after `beat`. */
  _indexAt(beat) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].beat < beat - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

export default Sequencer;
