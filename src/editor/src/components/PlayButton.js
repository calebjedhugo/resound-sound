import { useMemo, useState } from 'react';
import { Piano } from 'resound-sound';

const PlayButton = () => {
  const instrument = useMemo(() => new Piano(), []);
  const [pitch, setPitch] = useState('C4');
  return (
    <button
      onClick={() => {
        instrument.play({ length: 5000, pitch });
        setPitch(pitch === 'C4' ? 'A4' : 'C4');
      }}
    >
      Play
    </button>
  );
};

export default PlayButton;
