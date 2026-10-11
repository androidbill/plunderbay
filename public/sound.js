// Synthesized sound effects (WebAudio) — no audio files to load or cache.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('plunderbay_muted') === '1'; } catch { /* ignore */ }

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Browsers only allow audio after a user gesture.
export function unlockAudio() { ac(); }
export function isMuted() { return muted; }
export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem('plunderbay_muted', muted ? '1' : '0'); } catch { /* ignore */ }
}

function noise(c, dur) {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

function env(c, g, t, peak, attack, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(c, type, f0, f1, t, dur, peak) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(c, g, t, peak, 0.01, dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function filteredNoise(c, type, freq, t, dur, peak, q = 0.7) {
  const n = noise(c, dur);
  const f = c.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  env(c, g, t, peak, 0.005, dur);
  n.connect(f).connect(g).connect(c.destination);
  n.start(t);
}

const FX = {
  // cannon firing
  fire(c, t) {
    tone(c, 'sine', 160, 38, t, 0.5, 0.9);
    filteredNoise(c, 'lowpass', 900, t, 0.35, 0.7);
  },
  // shot lands in the water
  splash(c, t) {
    filteredNoise(c, 'highpass', 1800, t, 0.55, 0.45, 0.5);
    filteredNoise(c, 'bandpass', 700, t + 0.04, 0.4, 0.3, 1.2);
  },
  // shot hits a ship
  hit(c, t) {
    tone(c, 'sawtooth', 220, 45, t, 0.45, 0.5);
    filteredNoise(c, 'lowpass', 1400, t, 0.5, 0.8);
    filteredNoise(c, 'highpass', 3000, t + 0.12, 0.3, 0.25);
  },
  // ship goes down
  sunk(c, t) {
    FX.hit(c, t);
    [330, 262, 196, 131].forEach((f, i) => tone(c, 'triangle', f, f * 0.96, t + 0.3 + i * 0.22, 0.5, 0.35));
  },
  // treasure looted
  chest(c, t) {
    [880, 1109, 1319, 1760, 2093].forEach((f, i) => tone(c, 'triangle', f, f, t + i * 0.07, 0.32, 0.3));
    filteredNoise(c, 'highpass', 6000, t, 0.4, 0.15);
  },
  // it is your turn
  turn(c, t) {
    tone(c, 'sine', 659, 659, t, 0.35, 0.32);
    tone(c, 'sine', 880, 880, t + 0.14, 0.5, 0.32);
  },
  win(c, t) {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(c, 'triangle', f, f, t + i * 0.14, 0.4, 0.34));
  },
  lose(c, t) {
    [392, 349, 311, 262].forEach((f, i) => tone(c, 'sawtooth', f, f * 0.98, t + i * 0.28, 0.5, 0.2));
  },
  tick(c, t) { tone(c, 'square', 1200, 1200, t, 0.05, 0.12); },
};

export function play(name, delay = 0) {
  if (muted) return;
  const c = ac();
  if (!c || !FX[name]) return;
  try { FX[name](c, c.currentTime + delay + 0.01); } catch { /* ignore */ }
}
