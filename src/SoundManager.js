export default class SoundManager {
  constructor() {
    const sampleRate = 44100;
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    var context = new AudioCtor();

    // Check if hack is necessary. Only occurs in iOS6+ devices
    // and only when you first boot the iPhone, or play a audio/video
    // with a different sample rate
    var buffer = context.createBuffer(1, 1, sampleRate);
    var dummy = context.createBufferSource();
    dummy.buffer = buffer;
    dummy.connect(context.destination);
    dummy.start(0);
    dummy.disconnect();

    context.close(); // dispose old context
    context = new AudioCtor();

    this.soundscape = context;
  }

  verifySoundUnlocked = () => {
    if (this.soundUnlocked || !this.soundscape) {
      return;
    }

    var buffer = this.soundscape.createBuffer(1, 1, 22050);
    var source = this.soundscape.createBufferSource();
    source.buffer = buffer;
    source.connect(this.soundscape.destination);
    source.start(0);

    // by checking the play state after some time, we know if we're really unlocked
    setTimeout(function () {
      if (
        source.playbackState === source.PLAYING_STATE ||
        source.playbackState === source.FINISHED_STATE
      ) {
        this.soundUnlocked = true;
      }
    }, 0);
  };

  soundUnlocked = false;
}
