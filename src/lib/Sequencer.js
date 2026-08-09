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
const DEFAULT_LOOKAHEAD_MS = 100;
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
   * @param {number} [options.lookaheadMs=100] - audio-clock scheduling horizon.
   *   When every routed instrument supports it (schedulesAhead + a context
   *   clock), notes are handed to the instrument this far ahead of their beat
   *   with an exact `when`, so onsets ride the audio clock instead of the
   *   jittery main-thread timer. 0 disables (every note fires on the tick
   *   that crosses it, as before).
   * @param {number} [options.tailBeats=0] - beats to keep the cursor running past the last note
   * @param {Function} [options.now] - time source in ms (injectable for tests)
   */
  constructor({
    instrument = null,
    instruments = null,
    velocity,
    tickMs = DEFAULT_TICK_MS,
    lookaheadMs = DEFAULT_LOOKAHEAD_MS,
    tailBeats = 0,
    now = defaultNow,
  } = {}) {
    this.instrument = instrument;
    this.instruments = instruments || {};
    this.velocityOption = velocity;
    this.tickMs = tickMs;
    this.lookaheadMs = lookaheadMs;
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
    this._activeVoiceCount = null; // lazily computed; nulled when voices/mutes change
    this._cursor = 0;
    this._timer = null;
    this._lastNow = 0;
    // Lookahead scheduling state ("A Tale of Two Clocks"): `beat` stays the
    // HEARD position (onTick, seek, loop wrap); _schedBeat is how far ahead
    // events have already been handed to the instrument with an audio-clock
    // `when`. _schedWrapped marks the scheduler having crossed the A-B loop
    // boundary into the next pass while the heard cursor is still in this one.
    this._schedBeat = 0;
    this._schedWrapped = false;
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
    this._activeVoiceCount = null;
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
    this._schedBeat = this.beat;
    this._schedWrapped = false;
    const audioNow = this._audioNow();
    if (audioNow === null) {
      this._fireAt(this.beat); // notes sitting exactly on the cursor sound now
    } else {
      // Same notes sound now (when = audioNow), plus the first horizon fills.
      this._scheduleAhead(this.beat, audioNow);
    }
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
    this._schedBeat = this.beat;
    this._schedWrapped = false;
    if (this.playing) {
      const audioNow = this._audioNow();
      if (audioNow !== null) {
        // Take back the old position's lookahead window, then refill from the
        // new one so the next lookaheadMs isn't silent. (The legacy path fired
        // nothing ahead, so it has nothing to take back — the next tick just
        // plays on from the re-aimed cursor.)
        this._cancelScheduled();
        this._scheduleAhead(this.beat, audioNow);
      }
    }
    if (this.onTick) this.onTick(this.beat);
    return this.beat;
  }

  _cancelScheduled() {
    this._allInstruments().forEach((instrument) => {
      if (typeof instrument.cancelScheduled === 'function') instrument.cancelScheduled();
    });
  }

  /**
   * A mid-play loop edit invalidates the lookahead scheduled under the old
   * boundaries (notes past a new loopEnd, or a stale wrap). Unlike seek, the
   * heard position hasn't moved: cancel only the not-yet-heard future and
   * re-aim the scheduler just PAST the heard beat, so nothing already sounded
   * replays. Legacy mode never scheduled ahead, so it needs (and gets) no
   * resync — exactly the old behavior.
   */
  _resyncLoopEdit() {
    if (!this.playing) return;
    const audioNow = this._audioNow();
    if (audioNow === null) return;
    this._cancelScheduled();
    this._cursor = this._indexPast(this.beat);
    this._schedBeat = this.beat;
    this._schedWrapped = false;
    this._scheduleAhead(this.beat, audioNow);
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
    this._activeVoiceCount = null;
    return this;
  }

  unmute(voiceId) {
    this.muted.delete(voiceId);
    this._activeVoiceCount = null;
    return this;
  }

  /** @returns {boolean} whether the voice now SOUNDS (i.e. is unmuted) */
  toggleMute(voiceId) {
    if (this.muted.has(voiceId)) this.muted.delete(voiceId);
    else this.muted.add(voiceId);
    this._activeVoiceCount = null;
    return !this.muted.has(voiceId);
  }

  setMuted(voiceIds) {
    this.muted = new Set(voiceIds || []);
    this._activeVoiceCount = null;
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
    this._resyncLoopEdit();
    return this;
  }

  clearLoop() {
    const hadLoop = this.looping;
    this.loopStart = null;
    this.loopEnd = null;
    if (hadLoop) this._resyncLoopEdit();
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
    const audioNow = this._audioNow();

    // A loop set (or a seek made) mid-playback can leave the cursor PAST the
    // loop, where the wrap below can never trigger — the cursor would then run
    // on past the end of the song forever, silent and never reaching onEnd.
    // Snap it back, as play() does. A cursor sitting BEFORE the loop is left
    // alone: it plays the lead-in and enters the loop at loopEnd on its own.
    if (this.looping && this.beat >= this.loopEnd - EPS) {
      this.beat = this.loopStart;
      this._cursor = this._indexAt(this.beat);
      this._schedBeat = this.beat;
      this._schedWrapped = false;
      if (audioNow === null) this._fireAt(this.beat);
      // (lookahead: _scheduleAhead below sounds these with when = audioNow)
    }

    const from = this.beat;
    let to = from + dt / this.secondsPerBeat(from);
    const wrapping = this.looping && from < this.loopEnd && to >= this.loopEnd - EPS;

    if (audioNow !== null) {
      // Lookahead: events fire from the SCHEDULING cursor with an exact
      // audio-clock `when`; the heard beat only wraps and reports. When the
      // heard cursor crosses the loop boundary the scheduler is normally a
      // pass ahead already (_schedWrapped) and must not be re-aimed.
      if (wrapping) {
        to = this.loopStart;
        if (this._schedWrapped) {
          this._schedWrapped = false;
        } else {
          // Scheduler never reached the boundary (a stalled timer jumped the
          // heard beat over it): flush the rest of the old pass now, then
          // re-aim at the loop start like the legacy wrap does.
          this._fire(this.loopEnd, -EPS);
          this._cursor = this._indexAt(this.loopStart);
          this._schedBeat = this.loopStart;
        }
      }
      this.beat = to;
      this._scheduleAhead(to, audioNow);
    } else if (wrapping) {
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

  /**
   * The audio clock, when scheduling ahead is possible: every routed
   * instrument opts in (`schedulesAhead`) and exposes a context clock, so no
   * instrument would play a future `when` immediately. Otherwise null, and
   * the tick fires events the moment the cursor crosses them, exactly as
   * before lookahead existed (this is also the jsdom/test-mock path).
   */
  _audioNow() {
    if (!this.lookaheadMs) return null;
    const instruments = this._allInstruments();
    if (!instruments.length) return null;
    let time = null;
    for (const instrument of instruments) {
      if (!instrument.schedulesAhead || !instrument.context
        || typeof instrument.context.currentTime !== 'number') return null;
      // One shared AudioContext in practice (the manager is a singleton).
      time = instrument.context.currentTime;
    }
    return time;
  }

  /**
   * Hand every event within lookaheadMs of the heard beat to its instrument
   * with an exact audio-clock onset. Tempo is sampled at the heard beat —
   * over a 100ms horizon a rit/accel drifts it by well under a tick.
   * Handles at most one A-B wrap per call (later ticks catch up when the
   * loop is shorter than the horizon).
   */
  _scheduleAhead(heard, audioNow) {
    const spb = this.secondsPerBeat(heard);
    const lookBeats = (this.lookaheadMs / 1000) / spb;

    if (!this.looping) {
      const target = heard + lookBeats;
      while (this._cursor < this.events.length
        && this.events[this._cursor].beat < target + FIRE_SLOP) {
        const event = this.events[this._cursor];
        this._sound(event, audioNow + Math.max(0, event.beat - heard) * spb);
        this._cursor += 1;
      }
      this._schedBeat = Math.max(this._schedBeat, target);
      return;
    }

    if (heard >= this.loopEnd - EPS) return; // snap-back lands next tick
    const wrapTime = audioNow + (this.loopEnd - heard) * spb;
    const loopLength = this.loopEnd - this.loopStart;

    if (!this._schedWrapped) {
      const target = heard + lookBeats;
      // Old pass, up to the boundary (the loopEnd event belongs to the next).
      const limit = target >= this.loopEnd - EPS ? this.loopEnd - EPS : target + FIRE_SLOP;
      while (this._cursor < this.events.length && this.events[this._cursor].beat < limit) {
        const event = this.events[this._cursor];
        this._sound(event, audioNow + Math.max(0, event.beat - heard) * spb);
        this._cursor += 1;
      }
      if (target < this.loopEnd - EPS) {
        this._schedBeat = Math.max(this._schedBeat, target);
        return;
      }
      // The horizon crosses the boundary: wrap the scheduler into the next
      // pass and keep going from the loop start.
      this._cursor = this._indexAt(this.loopStart);
      this._schedBeat = this.loopStart;
      this._schedWrapped = true;
      const leftover = Math.min(target - this.loopEnd, loopLength);
      this._scheduleWrappedPass(this.loopStart + leftover, wrapTime);
      return;
    }

    // Scheduler already in the next pass; extend it as the heard beat closes
    // in on the boundary.
    const targetNew = this.loopStart
      + Math.min(Math.max(0, heard + lookBeats - this.loopEnd), loopLength);
    this._scheduleWrappedPass(targetNew, wrapTime);
  }

  /** Schedule next-pass events up to `target`, onsets relative to `wrapTime`. */
  _scheduleWrappedPass(target, wrapTime) {
    const spb = this.secondsPerBeat(this.loopStart);
    while (this._cursor < this.events.length
      && this.events[this._cursor].beat < target + FIRE_SLOP) {
      const event = this.events[this._cursor];
      this._sound(event, wrapTime + Math.max(0, event.beat - this.loopStart) * spb);
      this._cursor += 1;
    }
    this._schedBeat = Math.max(this._schedBeat, target);
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

  _sound(event, when) {
    if (this.muted.has(event.voiceId)) return;
    const instrument = this.instruments[event.voiceId] || this.instrument;
    if (!instrument) return;
    const ms = event.durationBeats * this.secondsPerBeat(event.beat) * 1000;
    // Legacy (fire-on-cross) keeps the exact 3-arg call shape — consumers spy
    // on startNote and a trailing `undefined` would show up in their asserts.
    if (when === undefined) instrument.startNote(event.pitch, ms, this._velocityFor(event));
    else instrument.startNote(event.pitch, ms, this._velocityFor(event), when);
  }

  _velocityFor(event) {
    if (event.velocity !== undefined) return event.velocity;
    if (typeof this.velocityOption !== 'function') return this.velocityOption;
    return this.velocityOption({
      note: event.note,
      voiceId: event.voiceId,
      beat: event.beat,
      durationBeats: event.durationBeats,
      activeVoices: this._activeVoices(),
      voiceCount: this.voiceIds.length,
      muted: this.muted,
    });
  }

  /**
   * Unmuted-voice count, cached — the velocity callback runs per sounding
   * note, and recounting (a filter + closure allocation) on every note adds
   * up. Invalidated by load() and the mute mutators; code that pokes
   * `this.muted` directly instead of using them was never supported.
   */
  _activeVoices() {
    if (this._activeVoiceCount === null) {
      this._activeVoiceCount = this.voiceIds
        .filter((id) => !this.muted.has(id)).length;
    }
    return this._activeVoiceCount;
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

  /** First event index strictly after `beat` (events there already sounded). */
  _indexPast(beat) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].beat <= beat + FIRE_SLOP) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

export default Sequencer;
