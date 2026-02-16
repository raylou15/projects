const baseUrl = import.meta.env.BASE_URL;

const iconMap = {
  help: `${baseUrl}icons/help.svg`,
  hint: `${baseUrl}icons/hint.svg`,
  players: `${baseUrl}icons/players.svg`,
  sound: `${baseUrl}icons/sound.svg`,
  mute: `${baseUrl}icons/mute.svg`,
};

export function getIcon(name, label) {
  const src = iconMap[name];
  if (!src) return null;
  return `<span class="icon-wrap"><img src="${src}" alt="" class="btn-icon" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/><span class="icon-fallback">${label}</span></span>`;
}
