import ResoundSound from '../ResoundSound';

class Piano extends ResoundSound {
  constructor() {
    super({ instrument: 'sine' });
  }
}

export default Piano;
