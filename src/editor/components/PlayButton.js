import Component from './Component.js';
import SoundManager from '../../SoundManager.js';

class PlayButton extends Component {
  constructor(parent) {
    super('button', parent);
    this.elem.textContent = 'Play';
    this.soundManager = new SoundManager();
    this.elem.onclick = this.soundManager.verifySoundUnlocked;
  }
}

export default PlayButton;
