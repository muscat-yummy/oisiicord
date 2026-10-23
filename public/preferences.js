export const defaults = {
  theme: "dark",
  guildNotifications: {},
  accent: "#5865f2",
  fontSize: 15,
  compact: false,
  reducedMotion: false,
  highContrast: false,
  showTimestamps: true,
  timeFormat: "24",
  enterToSend: true,
  notificationSound: true,
  callSounds: true,
  peerSounds: true,
  desktopNotifications: false,
  soundVolume: 45,
  inputVolume: 100,
  outputVolume: 100,
  inputDevice: "",
  cameraDevice: "",
  videoResolution: "720",
  outputDevice: "",
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  muted: false,
  deafened: false,
};
let prefs = { ...defaults },
  key = "oisiicord-preferences",
  soundContext;
export const preferences = () => prefs;
export function loadPreferences(user) {
  key = "oisiicord-preferences-" + user;
  try {
    prefs = { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    prefs = { ...defaults };
  }
  applyPreferences();
  return prefs;
}
export function updatePreferences(patch) {
  prefs = { ...prefs, ...patch };
  localStorage.setItem(key, JSON.stringify(prefs));
  applyPreferences();
  window.dispatchEvent(new CustomEvent("preferenceschange", { detail: patch }));
}
export function applyPreferences() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.style.setProperty("--accent", prefs.accent);
  document.documentElement.style.setProperty("--blue", prefs.accent);
  document.documentElement.style.setProperty(
    "--message-size",
    prefs.fontSize + "px",
  );
  document.body.classList.toggle("compact-messages", prefs.compact);
  document.body.classList.toggle("reduce-motion", prefs.reducedMotion);
  document.body.classList.toggle("high-contrast", prefs.highContrast);
  document.body.classList.toggle("hide-timestamps", !prefs.showTimestamps);
}
export function sound(kind) {
  if (
    (kind === "message" && !prefs.notificationSound) ||
    ((kind === "join" || kind === "leave") && !prefs.callSounds) ||
    ((kind === "peerJoin" || kind === "peerLeave") && !prefs.peerSounds) ||
    prefs.soundVolume === 0 ||
    prefs.deafened
  )
    return;
  try {
    soundContext ??= new AudioContext();
    soundContext.resume().catch(() => {});
    const notes = {
      join: [440, 554.37, 659.25],
      leave: [659.25, 493.88, 329.63],
      peerJoin: [523.25, 659.25],
      peerLeave: [493.88, 369.99],
      message: [783.99, 987.77],
      mute: [330],
      unmute: [523.25],
    };
    const now = soundContext.currentTime;
    for (const [i, hz] of (notes[kind] ?? notes.message).entries()) {
      const osc = soundContext.createOscillator(),
        gain = soundContext.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, now + i * 0.075);
      gain.gain.linearRampToValueAtTime(
        (prefs.soundVolume / 100) * 0.12,
        now + i * 0.075 + 0.012,
      );
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.075 + 0.16);
      osc.connect(gain);
      gain.connect(soundContext.destination);
      osc.start(now + i * 0.075);
      osc.stop(now + i * 0.075 + 0.17);
    }
  } catch {}
}
