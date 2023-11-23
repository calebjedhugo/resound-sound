import SoundManager from './SoundManager';

class ResoundSound {
  constructor(instrument = 'sine') {
    if (!window.resoundSoundscape) {
      const soundManager = new SoundManager();
      soundManager.verifySoundUnlocked();
      window.resoundSoundscape = soundManager.soundscape;
    }
    this.soundScape = window.resoundSoundscape;
    this.instrument = instrument;
  }

  play({ length = 3000 }) {
    const oscillator = this.soundScape.createOscillator();
    oscillator.type = this.instrument;

    oscillator.connect(this.soundScape.destination);

    oscillator.start();

    setTimeout(() => {
      oscillator.stop();
    }, length);
  }
}

export default ResoundSound;
