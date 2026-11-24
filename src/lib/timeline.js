/**
 * Shared-schema note arrays -> sounding events (SPEC-schema-playback.md).
 *
 * This is the ONE place the note schema is interpreted for audio: dotted
 * values, tie merging and chords. It reads the same arrays resound-notation
 * renders, on the same notated-beat timeline (data-beat units), so a consumer
 * never has to transform its data to play it.
 *
 * Pure — no audio, no timers, no DOM.
 */

let warnedUnsupported = false;

/**
 * How much a note's dots lengthen it: `dotted: 2` a double dot, x1.75 (an
 * integer n > 1: n dots, x(2 - 2^-n)); any other truthy `dotted` (`true`,
 * `1`) one dot, x1.5; none, x1.
 * @param {Object} note
 * @returns {number}
 */
export function dotScale(note) {
  const dotted = note && note.dotted;
  if (!dotted) return 1;
  const dots = Number.isInteger(dotted) && dotted > 1 ? dotted : 1;
  return 2 - 0.5 ** dots;
}

/**
 * Sounding length of one note, in beats of `basis` (4 = quarter note).
 * @param {Object} note
 * @param {number} [basis=4]
 * @returns {number}
 */
export function noteBeats(note, basis = 4) {
  if (!note || typeof note.length !== 'string') return 0;
  const [numerator, denominator] = note.length.split('/').map(Number);
  if (!numerator || !denominator) {
    throw new Error(`Invalid fraction format: ${note.length}`);
  }
  return ((numerator / denominator) * basis) * dotScale(note);
}

/**
 * Beats one voice element consumes. A chord takes its FIRST length-bearing
 * member — the rule resound-notation's elementBeats() uses, so notation and
 * audio agree on where the next element starts. Markers consume nothing.
 * @param {Object|Array} element
 * @param {number} [basis=4]
 * @returns {number}
 */
export function elementBeats(element, basis = 4) {
  if (Array.isArray(element)) {
    const first = element.find((note) => note && note.length);
    return first ? noteBeats(first, basis) : 0;
  }
  return noteBeats(element, basis);
}

/**
 * Flatten a song's voices into time-ordered sounding events.
 *
 * @param {Object} [song] - { voices: [{ id, notes }], basis } (other keys ignored)
 * @returns {{events: Array, totalBeats: number, pitches: Array<string>}}
 *   events: { beat, durationBeats, pitch, voiceId, note, velocity? }, sorted by beat
 */
export function buildTimeline(song) {
  const { voices = [], basis = 4 } = song || {};
  const events = [];
  let totalBeats = 0;

  voices.forEach((voice, index) => {
    const voiceId = voice.id !== undefined ? voice.id : index;
    const open = new Map(); // pitch -> the event a tie is still extending
    let beat = 0;

    for (const element of voice.notes || []) {
      if (!Array.isArray(element) && element && (element.tuplet || element.grace)) {
        if (!warnedUnsupported) {
          warnedUnsupported = true;
          // eslint-disable-next-line no-console
          console.warn(
            'resound-sound: tuplets and grace notes are not interpreted yet — '
            + 'their notes sound at face value.',
          );
        }
      }
      const members = Array.isArray(element) ? element : [element];
      const advance = elementBeats(element, basis);
      let sounded = false;

      for (const note of members) {
        if (!note || !note.length || !note.pitch) continue;
        sounded = true;
        const beats = noteBeats(note, basis);
        const held = open.get(note.pitch);
        // A tie continuation extends the open note instead of re-attacking.
        // Malformed data (pitch mismatch, orphan stop) sounds normally.
        if (held && (note.tie === 'continue' || note.tie === 'stop')) {
          held.durationBeats += beats;
          if (note.tie === 'stop') open.delete(note.pitch);
          continue;
        }
        const event = {
          beat, durationBeats: beats, pitch: note.pitch, voiceId, note,
        };
        if (note.velocity !== undefined) event.velocity = note.velocity;
        events.push(event);
        if (note.tie === 'start' || note.tie === 'continue') open.set(note.pitch, event);
        else open.delete(note.pitch);
      }

      // Rests carry no sustain, so they end any tie left open (SPEC-ties.md).
      if (!sounded && advance > 0) open.clear();
      beat += advance;
    }

    totalBeats = Math.max(totalBeats, beat);
  });

  // Stable sort keeps voices in declaration order at a shared onset.
  events.sort((a, b) => a.beat - b.beat);

  const pitches = [...new Set(events.map((event) => event.pitch))];
  return { events, totalBeats, pitches };
}

/**
 * How long each note of ONE voice sounds, for a player that walks its
 * elements one by one (Instrument.play; Theremin): parallel to `elements`,
 * a note's sounding beats (a tie start: its whole tied run; a tie
 * continuation: 0, held rather than struck), null for what does not sound
 * (rests, markers, notes without a length); a chord, an array of its
 * members'. The tie rules are buildTimeline's (it is its merge): ties are
 * matched per pitch, chord members each on their own, and a rest ends any
 * tie left open.
 * @param {Array} elements - notes, rests and chords
 * @param {number} [basis=4]
 * @returns {Array<?number|Array<?number>>}
 */
export function soundingBeats(elements, basis = 4) {
  const list = Array.isArray(elements) ? elements : [];
  // One voice: its events come out in the order its notes were met
  const { events } = buildTimeline({ voices: [{ notes: list }], basis });
  let next = 0;
  const of = (note) => {
    if (!note || !note.length || !note.pitch) return null;
    if (next < events.length && events[next].note === note) {
      next += 1;
      return events[next - 1].durationBeats;
    }
    return 0;
  };
  return list.map((element) => (Array.isArray(element) ? element.map(of) : of(element)));
}
