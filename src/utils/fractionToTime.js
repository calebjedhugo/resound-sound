/**
 * Takes in a rhythmic value and a tempo to return the length of the note in ms.
 * @param {string} fraction - a fraction as a string: '1/4' is a quarter note, for example.
 * @param {number} tempo - an integer representing beats per minute.
 * @param {number} basis - as integer indicating which rhythmic value gets the beat. Defaults to 4.
 */
const fractionToTime = (fraction = '1/4', tempo = 100, basis = 4) => {
  const [numerator, denomanator] = fraction
    .split('/')
    .map((elem) => Number(elem));
  const tempoNumber = Number(tempo);
  const basisNumber = Number(basis);
  if (!numerator || !denomanator)
    throw new Error(
      `fraction arg must be in the format, "<integer>/<integer>": for example "1/4". received ${fraction}.`
    );
  if (!tempoNumber)
    throw new Error(`tempo arg must be a number. Recieved ${tempo}`);
  if (!basisNumber)
    throw new Error(`basisc arg must be a number. Recieved ${basis}.`);
  return ((numerator * basis) / denomanator) * (60 / tempo) * 1000;
};

export default fractionToTime;
