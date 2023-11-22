const notesMeta = {
  C: [261.626, 0],
  'C#': [277.18, 1],
  D: [293.66, 2],
  Eb: [311.13, 3],
  E: [329.63, 4],
  F: [349.23, 5],
  'F#': [369.99, 6],
  G: [392.0, 7],
  Ab: [415.3, 8],
  A: [440, 9],
  Bb: [466.16, 10],
  B: [493.88, 11],
};

const noteConvert = (note) => {
  try {
    let f = note.split('');
    let noteInitial = f[0].toUpperCase();
    let octave = Number(f.pop());
    let idx = 1;
    let sharpsVsFlats = 0;
    while (/#|b/.test(f[idx])) {
      if (f[idx] === '#') {
        f[0] = Object.keys(this.notesMeta)[(this.notesMeta[f[0]][1] + 1) % 12];
        sharpsVsFlats += 1;
      }
      if (f[idx] == 'b') {
        f[0] = Object.keys(this.notesMeta)[
          (this.notesMeta[f[0]][1] + 143) % 12
        ];
        sharpsVsFlats -= 1;
      }
      idx += 1;
    }
    if (this.notesMeta[noteInitial][1] + sharpsVsFlats < 0) octave -= 1;
    if (this.notesMeta[noteInitial][1] + sharpsVsFlats > 11) octave += 1;
    return `${f[0]}/${octave}`;
  } catch (e) {
    console.error(`${note} could not be converted.`);
    throw new Error(e.message);
  }
};

export default noteConvert;
