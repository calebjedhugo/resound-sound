import { useMemo } from 'react';
import { Piano, sequences } from 'resound-sound';
const PlayButton = () => {
  const instrument = useMemo(() => new Piano(), []);

  return (
    <button
      onClick={() => {
        instrument.play(sequences.arpeggios.root);
      }}
    >
      Play
    </button>
  );
};

export default PlayButton;
