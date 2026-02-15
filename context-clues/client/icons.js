const iconMap = {
  help: "/icons/help.svg",
  hint: "/icons/hint.svg",
  players: "/icons/players.svg",
  sound: "/icons/sound.svg",
  mute: "/icons/mute.svg",
};

export function getIcon(name, label) {
  const src = iconMap[name];
  if (!src) return null;
  return `<span class="icon-wrap"><img src="${src}" alt="" class="btn-icon" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/><span class="icon-fallback">${label}</span></span>`;
}
