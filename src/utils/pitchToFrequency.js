import noteConvert from './noteConvert.js';
import { frequencies } from './staticValues.js';

/**
 * Accepts and number or a string, and returns the coorisponding frequency.
 * numbers are simply returns the value that was passed in as a number.
 * @param {string|number} pitchOrFrequency - Ether a pitch (A4) or a frequency (440)
 */
const pitchToFrequency = (pitchOrFrequency) => {
  if (typeof pitchOrFrequency === 'number') {
    return pitchOrFrequency;
  }
  if (Boolean(Number(pitchOrFrequency))) return Number(pitchOrFrequency);

  if (frequencies[noteConvert(pitchOrFrequency)]) {
    return frequencies[noteConvert(pitchOrFrequency)];
  }
};

export default pitchToFrequency;
