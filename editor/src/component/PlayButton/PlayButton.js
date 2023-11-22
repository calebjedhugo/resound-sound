import './PlayButton.module.css';
// TODO: make a symlink
import SoundManager from '../../../../SoundManager';

const soundManager = new SoundManager();

const PlayButton = () => (
  <button onClick={soundManager.verifySoundUnlocked}>Play</button>
);

export default PlayButton;
