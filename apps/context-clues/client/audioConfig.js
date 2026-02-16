export const AUDIO_CONFIG = {
  sfx: {
    // match main.js event names
    guess: "/audio/sfx/clientguess.wav",
    otherGuess: "/audio/sfx/otherplayerguess.wav",

    // use your existing error.mp3 for "error"
    error: "/audio/sfx/error.mp3",

    // played when a hint entry is inserted into rankings (we’ll wire it below)
    hint: "/audio/sfx/hintreveal.wav",

    correct: "/audio/sfx/correct.wav",

    // optional; if you don’t have one, point it at guess or omit
    uiClick: "/audio/sfx/clientguess.wav"
  },
  music: {
    // match audio.setMusicTrack("default")
    default: "/audio/music/loop_01.ogg"
  }
};
