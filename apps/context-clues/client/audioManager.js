const STORAGE_KEY = "context-clues-audio-prefs-v1";

function clampVolume(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function createAudioManager(config) {
  const prefs = {
    muted: false,
    sfxVolume: 0.35,
    musicVolume: 0.2,
    ...loadPrefs(),
  };

  prefs.sfxVolume = clampVolume(Number(prefs.sfxVolume), 0.35);
  prefs.musicVolume = clampVolume(Number(prefs.musicVolume), 0.2);

  let unlocked = false;
  let currentMusic = null;

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }

  function applyVolumes() {
    if (currentMusic) currentMusic.volume = prefs.musicVolume;
  }

  async function tryUnlock() {
    unlocked = true;
    applyVolumes();
  }

  function createAudio(src, loop = false) {
    if (!src) return null;
    const audio = new Audio(src);
    audio.loop = loop;
    audio.preload = "auto";
    return audio;
  }

  function playSfx(name) {
    if (prefs.muted || !unlocked) return;
    const src = config.sfx?.[name];
    if (!src) return;
    const audio = createAudio(src, false);
    if (!audio) return;
    audio.volume = prefs.sfxVolume;
    audio.play().catch(() => {});
  }

  function setMusicTrack(name = "default") {
    if (currentMusic) {
      currentMusic.pause();
      currentMusic = null;
    }
    const src = config.music?.[name];
    if (!src) return;
    currentMusic = createAudio(src, true);
    applyVolumes();
    if (!prefs.muted && unlocked) currentMusic.play().catch(() => {});
  }

  function startMusic() {
    if (prefs.muted || !unlocked || !currentMusic) return;
    currentMusic.play().catch(() => {});
  }

  function stopMusic() {
    if (currentMusic) currentMusic.pause();
  }

  function setMuted(muted) {
    prefs.muted = !!muted;
    persist();
    if (prefs.muted) stopMusic();
    else startMusic();
  }

  function setSfxVolume(volume) {
    prefs.sfxVolume = clampVolume(Number(volume), prefs.sfxVolume);
    persist();
  }

  function setMusicVolume(volume) {
    prefs.musicVolume = clampVolume(Number(volume), prefs.musicVolume);
    applyVolumes();
    persist();
  }

  function toggleMuted() {
    setMuted(!prefs.muted);
  }

  function unlockFromGesture() {
    if (unlocked) return;
    tryUnlock();
    startMusic();
  }

  function state() {
    return { ...prefs, unlocked };
  }

  return {
    state,
    playSfx,
    setMusicTrack,
    startMusic,
    stopMusic,
    setMuted,
    toggleMuted,
    setSfxVolume,
    setMusicVolume,
    unlockFromGesture,
  };
}
