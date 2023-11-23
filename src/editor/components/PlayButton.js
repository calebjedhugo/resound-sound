import Component from './Component.js';
import { ResoundSound } from '../../ResoundSound.js';

class PlayButton extends Component {
  constructor(parent) {
    super('button', parent);
    this.elem.textContent = 'Play';
    this.player = new ResoundSound();
    this.elem.onclick = this.player.play();
  }
}

export default PlayButton;
