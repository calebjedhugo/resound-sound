import { useMemo } from 'react';
import { Piano } from 'resound-sound';

const PlayButton = () => {
  const instrument = useMemo(() => new Piano(), []);

  return (
    <button
      onClick={() => {
        instrument.play({ length: 5000, pitch: 'C4' });
      }}
    >
      Play
    </button>
  );
};

export default PlayButton;
