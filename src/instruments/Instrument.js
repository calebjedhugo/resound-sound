import { getDuration } from '../lib/duration';
import audioContextManager from '../lib/AudioContextManager';

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A note sounds only if it carries a pitch; anything else is a rest. */
function isPitched(note) {
  return Boolean(note && note.pitch);
}

/**
 * Emit one note event to the instrument's `noteCallback` (recording, listening,
 * spatial audio). No-op when nobody is listening or the note is a rest.
 * @param {Instrument} instrument
 * @param {Object} note
 */
function emitNoteEvent(instrument, note) {
  if (!instrument.noteCallback || !isPitched(note)) return;
  instrument.noteCallback({
    pitch: note.pitch,
    length: note.length,
    timestamp: Date.now(),
    source: instrument.id,
    sourcePosition: instrument.sourcePosition,
  });
}

/**
 * Base class for all instruments
 * Handles playback state, pause/resume, and oscillator tracking
 */
class Instrument {
  constructor(id = null) {
    this.id = id; // Identifier for this instrument (e.g., creature ID)
    this.context = audioContextManager.getContext();

    // Track all active oscillators so we can stop them
    this.activeOscillators = new Set();

    // Pending trackOscillator() timeouts, cleared by stopAll().
    this._trackTimers = new Set();

    // Playback state for pause/resume functionality
    this.playbackState = {
      isPlaying: false,
      isPaused: false,
      shouldStop: false, // Flag to interrupt play loop
      isStopping: false, // The pending interrupt came from stop(), not pause()
      currentData: null, // Song data array
      currentIndex: 0, // Which note/chord we're on
      tempo: 120,
      basis: 4,
    };

    // Note callback for real-time note events (recording, listening, etc.)
    this.noteCallback = null;

    // Current volume multiplier (for distance-based volume)
    this.volumeMultiplier = 1.0;

    // Source position for spatial audio and listening
    this.sourcePosition = null;
  }

  /**
   * Play sequence of notes/chords
   * Supports pause/resume by tracking position
   * Supports optional offset property on notes for timing adjustments
   * @param {Object} params
   * @param {Array} params.data - Array of notes or chords (each can have optional offset in ms)
   * @param {number} params.tempo - BPM
   * @param {number} params.basis - Beat note (4 = quarter note)
   */
  async play({ data = [], tempo = 120, basis = 4 }) {
    // If already playing, ignore
    if (this.playbackState.isPlaying) return;

    const elements = Array.isArray(data) ? data : [];

    // Store playback parameters
    this.playbackState.currentData = elements;
    this.playbackState.tempo = tempo;
    this.playbackState.basis = basis;
    this.playbackState.isPlaying = true;
    this.playbackState.isPaused = false;
    this.playbackState.shouldStop = false;
    this.playbackState.isStopping = false;

    // Start from beginning (or resume from saved position if resuming)
    const startIndex = this.playbackState.currentIndex;

    // Pre-compute play schedule based on offsets
    const playSchedule = [];
    let naturalTime = 0; // Natural position based on cumulative durations

    for (let i = 0; i < elements.length; i += 1) {
      const element = elements[i];
      const offset = this.getElementOffset(element);
      const duration = this.getElementDuration(element, tempo, basis);

      playSchedule.push({
        element,
        playTime: naturalTime + offset, // Actual play time = natural + offset
        duration,
      });

      naturalTime += duration; // Advance natural time by duration
    }

    // Execute play schedule
    let elapsedTime = 0;

    for (let i = startIndex; i < playSchedule.length; i += 1) {
      // Check if we should stop (pause or stop was called)
      if (this.playbackState.shouldStop) {
        this.playbackState.shouldStop = false;
        this.playbackState.isPlaying = false;
        if (this.playbackState.isStopping) {
          // stop() already cleared the state — don't resurrect it as a pause.
          this.playbackState.isStopping = false;
        } else {
          this.playbackState.currentIndex = i; // Save position for resume()
          this.playbackState.isPaused = true;
        }
        return;
      }

      const { element, playTime } = playSchedule[i];

      // Sleep until it's time to play this note
      const waitTime = playTime - elapsedTime;
      if (waitTime > 0) {
        await sleep(waitTime);
      }

      // Update elapsed time to scheduled play time
      elapsedTime = playTime;

      // Play the note/chord (without sleeping)
      if (Array.isArray(element)) {
        // CHORD: Play multiple notes simultaneously
        this.playChordImmediate(element, tempo, basis);
      } else {
        // SINGLE NOTE: Play one note
        this.playNoteImmediate(element, tempo, basis);
      }
    }

    // Wait for the last note to finish before resetting state. An empty phrase
    // has nothing to wait for (and no last entry to read a duration from).
    const lastScheduled = playSchedule[playSchedule.length - 1];
    if (lastScheduled) await sleep(lastScheduled.duration);

    // Finished playing - reset state
    this.playbackState.isPlaying = false;
    this.playbackState.isPaused = false;
    this.playbackState.currentIndex = 0;
    this.playbackState.currentData = null;
  }

  /**
   * Get offset from a note or chord element
   * @param {Object|Array} element - Note or chord
   * @returns {number} Offset in milliseconds
   */
  // eslint-disable-next-line class-methods-use-this
  getElementOffset(element) {
    if (Array.isArray(element)) {
      // Chord - use offset from first note
      return element[0]?.offset || 0;
    }
    // Single note
    return element.offset || 0;
  }

  /**
   * Get duration of a note or chord element
   * @param {Object|Array} element - Note or chord
   * @param {number} tempo - BPM
   * @param {number} basis - Beat note
   * @returns {number} Duration in milliseconds
   */
  // eslint-disable-next-line class-methods-use-this
  getElementDuration(element, tempo, basis) {
    if (Array.isArray(element)) {
      // Chord - return shortest duration
      const durations = element.map((note) => getDuration(note.length, tempo, basis));
      return Math.min(...durations);
    }
    // Single note
    return getDuration(element.length, tempo, basis);
  }

  /**
   * Play a single note immediately (without sleeping)
   * @param {Object} note - Note data
   * @param {number} tempo - BPM
   * @param {number} basis - Beat note (4 = quarter note)
   */
  playNoteImmediate(note, tempo, basis) {
    if (!isPitched(note)) return; // REST

    const duration = getDuration(note.length, tempo, basis);
    emitNoteEvent(this, note);

    // Create and play note (Web Audio schedules it). velocity (0-1) is optional
    // and only meaningful to instruments that model it (e.g. Piano).
    this.startNote(note.pitch, duration, note.velocity);
  }

  /**
   * Play multiple notes simultaneously (chord) immediately (without sleeping)
   * @param {Array} notes - Array of note objects
   * @param {number} tempo - BPM
   * @param {number} basis - Beat note (4 = quarter note)
   */
  playChordImmediate(notes, tempo, basis) {
    const durations = notes.map((note) => getDuration(note.length, tempo, basis));

    // Every event is emitted before any note starts, so a listener sees the
    // whole chord as one simultaneity.
    notes.forEach((note) => emitNoteEvent(this, note));

    // Start all notes (Web Audio schedules them)
    notes.forEach((note, i) => {
      if (isPitched(note)) this.startNote(note.pitch, durations[i], note.velocity);
    });
  }

  /**
   * Pause playback
   * Stops after current note finishes, saves position
   */
  pause() {
    if (!this.playbackState.isPlaying) return;

    // Set flag to stop play loop
    this.playbackState.shouldStop = true;

    // Fade out all active oscillators quickly
    this.stopAll(0.05); // 50ms fade
  }

  /**
   * Resume playback from paused position
   */
  async resume() {
    if (!this.playbackState.isPaused || !this.playbackState.currentData) return;

    // Continue playing from saved position
    await this.play({
      data: this.playbackState.currentData,
      tempo: this.playbackState.tempo,
      basis: this.playbackState.basis,
    });
  }

  /**
   * Stop playback completely and reset.
   * `isStopping` tells a play loop still sleeping on a note that this interrupt
   * is a stop, so it exits without parking the state as a pause.
   */
  stop() {
    this.playbackState.shouldStop = true;
    this.playbackState.isStopping = true;
    this.playbackState.isPlaying = false;
    this.playbackState.isPaused = false;
    this.playbackState.currentIndex = 0;
    this.playbackState.currentData = null;

    // Stop all oscillators with quick fade
    this.stopAll(0.05);
  }

  /**
   * Emergency stop all active oscillators
   * @param {number} fadeTime - Fade out time in seconds (default 0.01)
   */
  stopAll(fadeTime = 0.01) {
    const { currentTime } = this.context;

    // Fade out to prevent clicks
    this.trackedGains().forEach((gainNode) => {
      try {
        gainNode.gain.cancelScheduledValues(currentTime);
        gainNode.gain.setValueAtTime(gainNode.gain.value, currentTime);
        gainNode.gain.linearRampToValueAtTime(0, currentTime + fadeTime);
      } catch (e) {
        // Gain node might be disconnected
      }
    });

    // Stop each oscillator after the fade
    this.activeOscillators.forEach(({ oscillator }) => {
      try {
        oscillator.stop(currentTime + fadeTime);
      } catch (e) {
        // Oscillator might already be stopped
      }
    });

    // Clear the set, and the per-note timers that would only re-delete from it
    this._trackTimers.forEach((timer) => clearTimeout(timer));
    this._trackTimers.clear();
    this.activeOscillators.clear();
  }

  /**
   * Play a single note and wait for it to finish.
   * The blocking counterpart of playNoteImmediate().
   */
  async playNote(note, tempo, basis) {
    const duration = getDuration(note.length, tempo, basis);
    this.playNoteImmediate(note, tempo, basis);
    await sleep(duration);
  }

  /**
   * Play multiple notes simultaneously (chord)
   * Waits for SHORTEST note, then continues (allows bass sustain)
   */
  async playChord(notes, tempo, basis) {
    const shortestDuration = Math.min(
      ...notes.map((note) => getDuration(note.length, tempo, basis)),
    );
    this.playChordImmediate(notes, tempo, basis);
    await sleep(shortestDuration);
  }

  /**
   * Update volume for all active oscillators (for distance-based volume)
   * Call this every frame from creature update()
   * @param {number} volumeMultiplier - Volume multiplier (0.0 to 1.0)
   */
  updateVolume(volumeMultiplier) {
    // Most frames bring the SAME volume: every tracked gain started at it or
    // is already ramping to it, so there is nothing to schedule.
    if (volumeMultiplier === this.volumeMultiplier) return;
    this.volumeMultiplier = volumeMultiplier;

    const { currentTime } = this.context;

    this.trackedGains().forEach((gainNode) => {
      try {
        // Smooth ramp to prevent clicks (10ms transition)
        gainNode.gain.setTargetAtTime(volumeMultiplier, currentTime, 0.01);
      } catch (e) {
        // Gain node might be disconnected
      }
    });
  }

  /**
   * The distinct gains the tracked oscillators play through, each once: a
   * live Piano note routes ~40 oscillators through one volume gain, and a
   * Random routes all of its notes through one.
   * @returns {Set<GainNode>}
   */
  trackedGains() {
    const gains = new Set();
    this.activeOscillators.forEach(({ gainNode }) => gains.add(gainNode));
    return gains;
  }

  /**
   * Start a note (creates oscillator with instrument's timbre)
   * MUST be implemented by subclass
   * @param {string|number} pitch - Note pitch (e.g., 'C/4') or frequency in Hz
   * @param {number} duration - Duration in milliseconds
   * @param {number} [velocity] - Strike velocity 0-1; only instruments that
   *   model it (e.g. Piano) do anything with it
   * @param {number} [when] - Audio-clock onset (context.currentTime seconds).
   *   Only instruments that set `schedulesAhead = true` honor it (e.g. Piano);
   *   the Sequencer checks that flag before scheduling ahead, so an
   *   instrument that ignores `when` is never handed a future onset.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  startNote(pitch, duration, velocity, when) {
    throw new Error('startNote() must be implemented by subclass');
  }

  /**
   * Cancel notes that were scheduled ahead (startNote with a future `when`)
   * but have not begun sounding. Notes already sounding are left to ring —
   * this is the seek-while-playing contract: the ear keeps what it already
   * heard, and only the not-yet-heard future is discarded.
   */
  cancelScheduled() {
    const { currentTime } = this.context;
    this.activeOscillators.forEach((oscillatorData) => {
      const { oscillator, noteOutput, startTime } = oscillatorData;
      if (startTime === undefined || startTime <= currentTime + 1e-3) return;
      try {
        oscillator.stop(currentTime); // started-but-not-sounding: cancels outright
        noteOutput.disconnect();
      } catch (e) {
        // Source may already be stopped or the graph torn down.
      }
      this.activeOscillators.delete(oscillatorData);
    });
  }

  /**
   * Helper to track an oscillator so it can be stopped later
   * Call this from subclass startNote() implementation
   * @param {OscillatorNode} oscillator
   * @param {GainNode} gainNode - The volume gain the oscillator plays
   *   through: what updateVolume() ramps and stopAll() fades
   * @param {number} duration - Duration in milliseconds
   * @param {number} [startTime] - Audio-clock onset, when scheduled ahead;
   *   lets cancelScheduled() tell a not-yet-sounding note from a ringing one
   * @param {AudioNode} [noteOutput] - The node joining this note to the rest
   *   of the graph, disconnected once the note is done. Defaults to
   *   gainNode; an instrument whose notes share one volume gain (Random)
   *   passes each note's own last node instead.
   */
  trackOscillator(oscillator, gainNode, duration, startTime, noteOutput = gainNode) {
    const oscillatorData = { oscillator, gainNode, startTime, noteOutput };

    // Add to active set
    this.activeOscillators.add(oscillatorData);

    // Free the note's graph when the source actually ends. Without this every
    // finished note leaves its gain connected to the bus forever — a leak on
    // Safari and a per-quantum summing cost everywhere. onended (not the
    // duration timer below) is the release-safe moment: sampled playback rings
    // until noteEnd + release, past the notated duration. A shared gain (live
    // Piano routes ~40 oscillators through one volume gain) gets disconnected
    // by whichever source ends first; the rest end at the same scheduled stop,
    // and disconnecting a disconnected node is a no-op.
    oscillator.onended = () => {
      try {
        noteOutput.disconnect();
      } catch (e) {
        // Node may already be disconnected (shared gain, or context torn down).
      }
      this.activeOscillators.delete(oscillatorData);
    };

    // Fallback removal from the active set after the notated duration — the
    // long-standing bound stopAll()/updateVolume() iterate within, and the
    // only cleanup in environments whose mocks never fire onended.
    const timer = setTimeout(() => {
      this._trackTimers.delete(timer);
      this.activeOscillators.delete(oscillatorData);
    }, duration);
    this._trackTimers.add(timer);
  }
}

export default Instrument;
