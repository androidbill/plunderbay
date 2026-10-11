import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import { play, unlockAudio, isMuted, setMuted } from './sound.js';
import {
  SIZE, COLS, SHIPS, ITEMS, itemById, tk, shotKey, coordName, MISS, HIT, LOOT,
  cellMap, itemCells, placeItem, isComplete, randomFleet, isSunk, shipHits, sunkShipIds, lootedCount,
  toArr, currentPid, seatsPerTeam, findFreeSeat, lobbyReady, startGame, applyShot, pickShot,
  teamPlayers, botPick, BOT_LEVELS,
} from './rules.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const TEAMS = [
  { name: 'Red Corsairs', short: 'Red', color: '#ff6b52', emoji: '🔴' },
  { name: 'Blue Buccaneers', short: 'Blue', color: '#4aa8ee', emoji: '🔵' },
];

// ---------------------------------------------------------------- Firebase shape fix-ups
// RTDB silently drops null / {} / [] and returns small integer-keyed objects as arrays.
// Everything read back from Firebase goes through here before the engine or UI touches it.
function normalizeRoom(r) {
  if (!r) return r;
  const o = { ...r };
  // An onDisconnect write can resurrect a bare { left: true } node for a removed player.
  o.players = Object.fromEntries(Object.entries(o.players || {}).filter(([, p]) => p && p.name));
  o.settings = { mode: 2, turnSeconds: 0, ...(o.settings || {}) };
  o.fleets = { t0: {}, t1: {}, ...(o.fleets || {}) };
  o.ready = o.ready || {};
  if (o.game) {
    o.game = {
      ...o.game,
      order: toArr(o.game.order),
      shots: { t0: {}, t1: {}, ...(o.game.shots || {}) },
      last: o.game.last || null,
      winner: o.game.winner ?? null,
    };
  }
  return o;
}

let serverTimeOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => { serverTimeOffset = snap.val() || 0; });
const serverNow = () => Date.now() + serverTimeOffset;

// ---------------------------------------------------------------- identity
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
let playerId = store.get('plunderbay_pid');
if (!playerId) { playerId = uid(); store.set('plunderbay_pid', playerId); }
let myName = store.get('plunderbay_name') || '';
let homeMode = store.get('plunderbay_mode') === '4' ? 4 : 2;
let homeLevel = BOT_LEVELS.includes(store.get('plunderbay_level')) ? store.get('plunderbay_level') : 'medium';
const BOT_NAMES = ['Barnacle Bob', 'Salty Sue', 'Peg-Leg Pete', 'Anchor Annie', 'Captain Crunch', 'Mad Maggie', 'One-Eye Jack', 'Rum Runner'];

// ---------------------------------------------------------------- dom helpers
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SCREENS = ['screen-home', 'screen-join', 'screen-lobby', 'screen-place', 'screen-game'];
function showScreen(id) { for (const s of SCREENS) (s === id ? show : hide)($(s)); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 3000);
}

let shoutTimer = null;
function shoutout(msg, accent, duration = 1900) {
  const box = $('shoutout');
  const card = $('shoutout-card');
  card.textContent = msg;
  card.style.setProperty('--c', accent || 'var(--gold)');
  show(box);
  card.classList.remove('show');
  void card.offsetWidth; // restart the CSS animation
  card.classList.add('show');
  clearTimeout(shoutTimer);
  shoutTimer = setTimeout(() => { card.classList.remove('show'); hide(box); }, duration);
}

document.addEventListener('pointerdown', unlockAudio, { once: false, passive: true });

// ---------------------------------------------------------------- menu / about / update
function refreshSoundLabel() { $('menu-sound').textContent = isMuted() ? '🔇 Sound off' : '🔊 Sound on'; }
refreshSoundLabel();

$('kebab-btn').addEventListener('click', () => {
  $('menu-quit').classList.toggle('hidden', !currentRoomCode);
  $('kebab-menu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!$('kebab-menu').contains(e.target) && e.target !== $('kebab-btn')) hide($('kebab-menu'));
});
$('menu-sound').addEventListener('click', () => { setMuted(!isMuted()); refreshSoundLabel(); hide($('kebab-menu')); });
$('menu-rules').addEventListener('click', () => { hide($('kebab-menu')); show($('rules-modal')); });
$('btn-rules').addEventListener('click', () => show($('rules-modal')));
$('rules-close').addEventListener('click', () => hide($('rules-modal')));

// A plain location.reload() can silently no-op on an installed PWA; force a genuinely
// new navigation with a cache-busting param, with layered fallbacks.
async function hardRefresh() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    for (const r of regs || []) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  } catch { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url.toString());
  setTimeout(() => { location.href = url.toString(); }, 1200);
  setTimeout(() => { location.reload(); }, 2600);
}
$('menu-refresh').addEventListener('click', () => { toast('Updating…'); hardRefresh(); });

function inviteUrl() {
  return location.origin + location.pathname + (currentRoomCode ? `?room=${currentRoomCode}` : '');
}
async function shareInvite() {
  const url = inviteUrl();
  try {
    if (navigator.share) await navigator.share({ title: 'Plunder Bay', text: currentRoomCode ? `Join my Plunder Bay game — room ${currentRoomCode}` : 'Plunder Bay', url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
}
$('menu-share').addEventListener('click', shareInvite);
$('lobby-share').addEventListener('click', shareInvite);
$('menu-about').addEventListener('click', () => { hide($('kebab-menu')); $('about-version').textContent = `Version ${APP_VERSION}`; show($('about-modal')); });
$('about-close').addEventListener('click', () => hide($('about-modal')));
$('version-label').textContent = `v${APP_VERSION}`;

for (const btn of document.querySelectorAll('.back-btn')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.back === 'screen-home' && currentRoomCode) { leaveGame(); return; }
    showScreen(btn.dataset.back);
  });
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!$('screen-home').classList.contains('hidden')) show($('install-banner'));
});
$('btn-install').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hide($('install-banner'));
});

// Checked on load, on tab-foreground, and on an interval — a deploy can land mid-game.
let updateBannerShown = false;
async function checkVersion() {
  if (updateBannerShown) return;
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
    const text = await res.text();
    const match = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (match && match[1] !== APP_VERSION) { updateBannerShown = true; show($('update-banner')); }
  } catch { /* offline */ }
}
checkVersion();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
setInterval(checkVersion, 2 * 60 * 1000);
$('update-refresh').addEventListener('click', () => { $('update-refresh').textContent = 'Updating…'; hardRefresh(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
}

// ================================================================== ROOM STATE
let currentRoomCode = null;
let roomUnsub = null;
let latestRoom = null;
let timerInterval = null;
let autoBusy = false;

const roomRef = (code, ...path) => ref(db, ['rooms', code, ...path].join('/'));
const randomCode = () => WORD_CODES[Math.floor(Math.random() * WORD_CODES.length)];
const isHost = () => latestRoom?.hostId === playerId;
const myTeam = () => latestRoom?.players?.[playerId]?.team;
const fleetOf = (room, team) => room.fleets?.[tk(team)] || {};
const playerName = (room, pid) => room.players?.[pid]?.name || 'A pirate';

// ---------------------------------------------------------------- home
function paintHomeMode() {
  for (const b of $('home-mode').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.mode) === homeMode);
}
paintHomeMode();
$('home-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  homeMode = Number(b.dataset.mode);
  store.set('plunderbay_mode', String(homeMode));
  paintHomeMode();
});
function paintHomeLevel() {
  for (const b of $('home-level').querySelectorAll('button')) b.classList.toggle('on', b.dataset.level === homeLevel);
}
paintHomeLevel();
$('home-level').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-level]');
  if (!b) return;
  homeLevel = b.dataset.level;
  store.set('plunderbay_level', homeLevel);
  paintHomeLevel();
});
$('btn-solo').addEventListener('click', async () => {
  myName = cleanName($('home-name').value);
  store.set('plunderbay_name', myName);
  $('btn-solo').disabled = true;
  try { await createRoom(true); } catch (e) { toast('Could not start — check your connection'); }
  $('btn-solo').disabled = false;
});
$('home-name').value = myName;
$('join-name').value = myName;

function cleanName(raw) {
  const n = (raw || '').trim().slice(0, 14);
  return n || 'Pirate ' + Math.floor(Math.random() * 90 + 10);
}

$('btn-host').addEventListener('click', async () => {
  myName = cleanName($('home-name').value);
  store.set('plunderbay_name', myName);
  $('btn-host').disabled = true;
  try { await createRoom(); } catch (e) { toast('Could not create a room — check your connection'); }
  $('btn-host').disabled = false;
});
$('btn-join').addEventListener('click', () => {
  $('join-name').value = $('home-name').value || myName;
  showScreen('screen-join');
  $('join-code').focus();
});
$('join-go').addEventListener('click', async () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) { toast('Enter the room code'); return; }
  myName = cleanName($('join-name').value);
  store.set('plunderbay_name', myName);
  $('join-go').disabled = true;
  try { await joinRoom(code); } catch (e) { toast('Could not join — check your connection'); }
  $('join-go').disabled = false;
});
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-go').click(); });

function makeBot(players, settings, seat) {
  const used = new Set(Object.values(players).map((p) => p.name));
  const name = '🤖 ' + (BOT_NAMES.find((n) => !used.has('🤖 ' + n)) || 'Bot ' + Math.floor(Math.random() * 90 + 10));
  return { name, team: seat.team, seat: seat.seat, bot: true, level: settings.botLevel || 'medium', joinedAt: Date.now() };
}

// Solo = a normal room where every other seat is a computer pirate and play starts at once.
async function createRoom(solo = false) {
  let code;
  for (let tries = 0; tries < 20; tries++) {
    code = randomCode();
    const snap = await get(roomRef(code));
    if (!snap.exists()) break;
  }
  const settings = { mode: homeMode, turnSeconds: solo ? 0 : 45, botLevel: homeLevel };
  const players = { [playerId]: { name: myName, team: 0, seat: 0, joinedAt: Date.now() } };
  if (solo) {
    for (let i = 0; i < seatsPerTeam(homeMode) * 2 - 1; i++) {
      const seat = findFreeSeat({ settings, players });
      players['bot_' + i + uid().slice(0, 4)] = makeBot(players, settings, seat);
    }
  }
  await set(roomRef(code), {
    createdAt: Date.now(),
    hostId: playerId,
    status: solo ? 'placing' : 'lobby',
    settings,
    players,
  });
  enterRoom(code);
}

async function joinRoom(code) {
  let problem = null;
  const res = await runTransaction(roomRef(code), (cur) => {
    problem = null;
    if (!cur) return cur;   // first pass runs with no cached data; the SDK retries with the real room
    const room = normalizeRoom(cur);
    if (room.players[playerId]) {            // rejoining
      cur.players[playerId].name = myName;
      return cur;
    }
    if (room.status !== 'lobby') { problem = 'That game has already started'; return; }
    const seat = findFreeSeat(room);
    if (!seat) { problem = 'That room is full'; return; }
    cur.players = cur.players || {};
    cur.players[playerId] = { name: myName, team: seat.team, seat: seat.seat, joinedAt: Date.now() };
    return cur;
  });
  if (!res.committed) { toast(problem || 'Could not join that room'); return; }
  if (!res.snapshot.exists()) { toast('Room not found'); return; }
  enterRoom(code);
}

function enterRoom(code) {
  currentRoomCode = code;
  resetGameFx();
  store.set('plunderbay_room', code);
  update(roomRef(code, 'players', playerId), { left: false }).catch(() => {});
  onDisconnect(roomRef(code, 'players', playerId, 'left')).set(true);
  if (roomUnsub) roomUnsub();
  clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);
  let first = true;
  roomUnsub = onValue(roomRef(code), (snap) => {
    const raw = snap.val();
    if (!raw) { toast('That room is gone'); dropRoom(); return; }
    latestRoom = normalizeRoom(raw);
    if (!latestRoom.players[playerId]) {
      if (!first) toast('You were removed from the room');
      dropRoom();
      return;
    }
    first = false;
    renderRoom();
  });
}

function dropRoom() {
  if (currentRoomCode) onDisconnect(roomRef(currentRoomCode, 'players', playerId, 'left')).cancel().catch(() => {});
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  clearInterval(timerInterval);
  currentRoomCode = null;
  latestRoom = null;
  store.del('plunderbay_room');
  hide($('over-modal'));
  hide($('turn-timer'));
  showScreen('screen-home');
}

async function leaveGame() {
  const code = currentRoomCode;
  const room = latestRoom;
  if (!code || !room) { dropRoom(); return; }
  if (room.status !== 'lobby' && !confirm('Leave this game? Your crew will have to play without you.')) return;
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  try {
    onDisconnect(roomRef(code, 'players', playerId, 'left')).cancel();
    if (room.status === 'lobby') {
      await runTransaction(roomRef(code), (cur) => {
        if (!cur) return cur;
        if (cur.players) delete cur.players[playerId];
        const rest = Object.keys(cur.players || {});
        if (!rest.length) return null;
        if (cur.hostId === playerId) cur.hostId = rest[0];
        return cur;
      });
    } else {
      await update(roomRef(code, 'players', playerId), { left: true });
    }
  } catch { /* ignore */ }
  dropRoom();
}
$('menu-quit').addEventListener('click', () => { hide($('kebab-menu')); leaveGame(); });
$('over-leave').addEventListener('click', () => leaveGame());

// ---------------------------------------------------------------- dispatch
function renderRoom() {
  const room = latestRoom;
  if (!room) return;
  if (room.status === 'lobby') { hide($('over-modal')); resetRoundFx(); renderLobby(); showScreen('screen-lobby'); }
  else if (room.status === 'placing') { hide($('over-modal')); resetRoundFx(); renderPlace(); showScreen('screen-place'); }
  else { renderGame(); showScreen('screen-game'); }
  driveBots();
}

// ---------------------------------------------------------------- lobby
function renderLobby() {
  const room = latestRoom;
  const host = isHost();
  const mode = room.settings.mode;
  const per = seatsPerTeam(mode);
  $('lobby-code').textContent = currentRoomCode;

  let html = '';
  for (let team = 0; team < 2; team++) {
    html += `<div class="team-card" style="--tc:${TEAMS[team].color}"><h3>${TEAMS[team].emoji} ${TEAMS[team].name}</h3>`;
    for (let seat = 0; seat < per; seat++) {
      const entry = Object.entries(room.players).find(([, p]) => p.team === team && p.seat === seat);
      if (entry) {
        const [pid, p] = entry;
        const cls = ['slot', 'filled', pid === playerId ? 'me' : '', p.left ? 'away' : ''].join(' ');
        const kick = host && pid !== playerId ? `<button class="kick" data-kick="${esc(pid)}" aria-label="Remove">✕</button>` : '';
        const lvl = p.bot ? `<span class="lvl">${esc(p.level || '')}</span>` : '';
        html += `<div class="${cls}"><span class="nm">${pid === room.hostId ? '👑 ' : ''}${esc(p.name)}${lvl}</span>${kick}</div>`;
      } else {
        html += host
          ? `<div class="slot empty col"><button class="take" data-team="${team}" data-seat="${seat}">⚓ Take this seat</button><button class="addbot" data-addbot-team="${team}" data-addbot-seat="${seat}">🤖 Add bot</button></div>`
          : `<button class="slot empty take" data-team="${team}" data-seat="${seat}">⚓ Take this seat</button>`;
      }
    }
    html += '</div>';
  }
  $('lobby-teams').innerHTML = html;

  for (const b of $('lobby-mode').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.mode) === mode);
  $('lobby-mode').classList.toggle('locked', !host);
  $('lobby-level').value = room.settings.botLevel || 'medium';
  $('lobby-level').disabled = !host;
  $('lobby-timer').value = String(room.settings.turnSeconds || 0);
  $('lobby-timer').disabled = !host;

  const ready = lobbyReady(room);
  const need = per * 2 - Object.keys(room.players).length;
  show($('lobby-start'));
  $('lobby-start').disabled = !host || !ready;
  $('lobby-start').textContent = host ? 'Set Sail ⛵' : 'Waiting for the host…';
  $('lobby-hint').textContent = !ready
    ? `Waiting for ${need} more pirate${need === 1 ? '' : 's'} — share the code!`
    : (host ? (mode === 4 ? 'Crews are set. Teammates share one fleet.' : 'Both captains aboard!') : 'Everyone is aboard.');
}

$('lobby-teams').addEventListener('click', async (e) => {
  const kick = e.target.closest('[data-kick]');
  if (kick && isHost()) {
    update(roomRef(currentRoomCode, 'players'), { [kick.dataset.kick]: null });
    return;
  }
  const add = e.target.closest('[data-addbot-team]');
  if (add && isHost()) {
    const team = Number(add.dataset.addbotTeam), seat = Number(add.dataset.addbotSeat);
    const bid = 'bot_' + uid().slice(0, 8);
    await runTransaction(roomRef(currentRoomCode), (cur) => {
      if (!cur) return cur;
      const room = normalizeRoom(cur);
      if (room.status !== 'lobby') return;
      if (Object.values(room.players).some((p) => p.team === team && p.seat === seat)) return;
      cur.players = cur.players || {};
      cur.players[bid] = makeBot(room.players, room.settings, { team, seat });
      return cur;
    });
    return;
  }
  const slot = e.target.closest('.take');
  if (!slot) return;
  const team = Number(slot.dataset.team), seat = Number(slot.dataset.seat);
  let taken = false;
  await runTransaction(roomRef(currentRoomCode, 'players'), (players) => {
    taken = false;
    if (!players || !players[playerId]) return players;
    if (Object.values(players).some((p) => p.team === team && p.seat === seat)) { taken = true; return; }
    players[playerId].team = team;
    players[playerId].seat = seat;
    return players;
  });
  if (taken) toast('Someone just took that seat');
});

$('lobby-mode').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || !isHost()) return;
  const mode = Number(b.dataset.mode);
  let blocked = false;
  await runTransaction(roomRef(currentRoomCode), (cur) => {
    blocked = false;
    if (!cur) return cur;
    const room = normalizeRoom(cur);
    const count = Object.keys(room.players).length;
    if (mode === 2 && count > 2) { blocked = true; return; }
    if (mode === 2) {
      // collapse everyone onto seat 0 of their team; refuse if both players share a team
      const teams = Object.values(room.players).map((p) => p.team);
      if (teams.length === 2 && teams[0] === teams[1]) {
        const ids = Object.keys(room.players);
        cur.players[ids[1]].team = 1 - teams[0];
      }
      for (const pid of Object.keys(cur.players)) cur.players[pid].seat = 0;
    }
    cur.settings = { ...(cur.settings || {}), mode };
    return cur;
  });
  if (blocked) toast('Too many pirates aboard for 2-player mode — remove someone first');
});
$('lobby-level').addEventListener('change', () => {
  if (!isHost()) return;
  const level = $('lobby-level').value;
  const u = { 'settings/botLevel': level };
  for (const [pid, p] of Object.entries(latestRoom.players)) if (p.bot) u[`players/${pid}/level`] = level;
  update(roomRef(currentRoomCode), u);
});
$('lobby-timer').addEventListener('change', () => {
  if (isHost()) update(roomRef(currentRoomCode, 'settings'), { turnSeconds: Number($('lobby-timer').value) });
});
$('lobby-start').addEventListener('click', async () => {
  const room = latestRoom;
  if (!isHost() || !lobbyReady(room)) return;
  await update(roomRef(currentRoomCode), { status: 'placing', fleets: null, ready: null, game: null, turnStartedAt: null });
});

// ---------------------------------------------------------------- placement
let selectedItem = null;
let placeH = 1;

function firstUnplaced(fleet) { return ITEMS.find((i) => !fleet[i.id])?.id || null; }

function boardCellClasses(fleet, map, x, y) {
  const info = map.get(`${x},${y}`);
  if (!info) return '';
  const item = itemById(info.id);
  if (item.kind === 'chest') return 'chest';
  const pos = fleet[info.id];
  return `ship ${pos.h ? 'h' : 'v'}${info.idx === 0 ? ' bow' : ''}${info.idx === item.len - 1 ? ' stern' : ''}`;
}

function gridShell(cellFn) {
  let h = '<div></div>';
  for (let x = 0; x < SIZE; x++) h += `<div class="g-lab">${COLS[x]}</div>`;
  for (let y = 0; y < SIZE; y++) {
    h += `<div class="g-lab">${y + 1}</div>`;
    for (let x = 0; x < SIZE; x++) h += cellFn(x, y);
  }
  return h;
}

function renderPlace() {
  const room = latestRoom;
  const team = myTeam();
  const fleet = fleetOf(room, team);
  const map = cellMap(fleet);
  const teamReady = !!room.ready[tk(team)];

  if (!selectedItem || fleet[selectedItem]) selectedItem = firstUnplaced(fleet);

  const mates = Object.entries(room.players).filter(([pid, p]) => p.team === team && pid !== playerId).map(([, p]) => p.name);
  $('place-head').innerHTML = `${TEAMS[team].emoji} ${TEAMS[team].name}<small>${mates.length ? `Fleet shared with ${esc(mates.join(', '))}` : 'Hide your fleet and treasure'}</small>`;

  $('place-grid').innerHTML = gridShell((x, y) => {
    const cls = boardCellClasses(fleet, map, x, y);
    return `<button class="cell ${cls}" data-x="${x}" data-y="${y}" aria-label="${coordName(x, y)}"></button>`;
  });

  $('place-tray').innerHTML = ITEMS.map((it) => {
    const placed = !!fleet[it.id];
    const pips = Array.from({ length: it.len }, () => '<span class="pip"></span>').join('');
    const label = it.kind === 'chest' ? '💰' : it.name;
    return `<button class="tray-item ${it.kind}${selectedItem === it.id ? ' sel' : ''}${placed ? ' done' : ''}" data-item="${it.id}"><span>${label}</span><span class="pips">${pips}</span></button>`;
  }).join('');

  $('place-rot-label').textContent = placeH ? 'Across' : 'Down';
  const complete = isComplete(fleet);
  const other = TEAMS[1 - team].name;
  const otherReady = !!room.ready[tk(1 - team)];
  const left = ITEMS.filter((i) => !fleet[i.id]).length;

  let status;
  if (teamReady) status = otherReady ? 'Starting…' : `Your crew is ready — waiting for the ${other}…`;
  else if (!complete) status = `Tap a spot on the map to place the selected item (${left} left). Tap a placed item to move it.`;
  else status = 'Fleet is set! Tap Ready when you are happy with it.';
  $('place-status').textContent = status;

  const btn = $('place-ready');
  btn.disabled = !complete && !teamReady;
  btn.textContent = teamReady ? 'Not ready — let me change something' : 'Ready! ⚓';
  btn.classList.toggle('btn-secondary', teamReady);
  btn.classList.toggle('btn-primary', !teamReady);
  for (const id of ['place-rotate', 'place-random', 'place-clear']) $(id).disabled = teamReady;
}

function writeFleet(updates) {
  const t = tk(myTeam());
  const u = { [`ready/${t}`]: null };
  for (const [k, v] of Object.entries(updates)) u[`fleets/${t}/${k}`] = v;
  return update(roomRef(currentRoomCode), u);
}

$('place-grid').addEventListener('click', (e) => {
  const c = e.target.closest('.cell');
  if (!c || !latestRoom) return;
  const x = Number(c.dataset.x), y = Number(c.dataset.y);
  const team = myTeam();
  const fleet = fleetOf(latestRoom, team);
  if (latestRoom.ready[tk(team)]) { toast('Tap "Not ready" to rearrange'); return; }
  const info = cellMap(fleet).get(`${x},${y}`);
  if (info) {                                   // pick an item back up
    selectedItem = info.id;
    if (itemById(info.id).kind === 'ship') placeH = fleet[info.id].h ? 1 : 0;
    writeFleet({ [info.id]: null });
    return;
  }
  if (!selectedItem) { toast('Everything is placed — tap Ready!'); return; }
  const item = itemById(selectedItem);
  const h = item.len === 1 ? 1 : placeH;
  const px = Math.min(x, SIZE - (h ? item.len : 1));       // nudge so it stays on the map
  const py = Math.min(y, SIZE - (h ? 1 : item.len));
  const next = placeItem(fleet, selectedItem, px, py, h);
  if (!next) { toast('Ships can\'t overlap'); return; }
  const placedId = selectedItem;
  selectedItem = firstUnplaced(next);
  writeFleet({ [placedId]: { x: px, y: py, h } });
});

$('place-tray').addEventListener('click', (e) => {
  const b = e.target.closest('[data-item]');
  if (!b || latestRoom.ready[tk(myTeam())]) return;
  const fleet = fleetOf(latestRoom, myTeam());
  const id = b.dataset.item;
  if (fleet[id]) {                   // tapping a placed item's chip picks it up
    if (itemById(id).kind === 'ship') placeH = fleet[id].h ? 1 : 0;
    selectedItem = id;
    writeFleet({ [id]: null });
  } else {
    selectedItem = id;
    renderPlace();
  }
});
$('place-rotate').addEventListener('click', () => { placeH = placeH ? 0 : 1; renderPlace(); });
$('place-random').addEventListener('click', () => {
  const f = randomFleet();
  selectedItem = null;
  writeFleet(f);
});
$('place-clear').addEventListener('click', () => {
  selectedItem = ITEMS[0].id;
  const u = {};
  for (const it of ITEMS) u[it.id] = null;
  writeFleet(u);
});

$('place-ready').addEventListener('click', async () => {
  const team = myTeam();
  const t = tk(team);
  if (latestRoom.ready[t]) { update(roomRef(currentRoomCode, 'ready'), { [t]: null }); return; }
  if (!isComplete(fleetOf(latestRoom, team))) { toast('Place everything first'); return; }
  await markReady(team, playerId);
});

function markReady(team, byPid) {
  const t = tk(team);
  return runTransaction(roomRef(currentRoomCode), (cur) => {
    if (!cur) return cur;
    const room = normalizeRoom(cur);
    if (room.status !== 'placing' || !isComplete(room.fleets[t])) return;
    room.ready = { ...room.ready, [t]: byPid };
    if (room.ready.t0 && room.ready.t1 && isComplete(room.fleets.t0) && isComplete(room.fleets.t1)) {
      const started = startGame(room, Math.random() < 0.5 ? 1 : 0);
      started.turnStartedAt = serverTimestamp();
      return started;
    }
    return room;
  });
}

// ---------------------------------------------------------------- computer pirates
// The host's client plays for every bot: places an all-bot crew's fleet, and fires on a
// bot's turn after a short pause. (If the host leaves, a human's turn timer still keeps
// things moving through the fallback shooter.)
let botMoveFor = null;
let botTimer = null;
const botPlacing = { 0: false, 1: false };

function driveBots() {
  const room = latestRoom;
  if (!room || !isHost()) return;
  if (room.status === 'placing') {
    for (const team of [0, 1]) {
      const members = teamPlayers(room, team);
      if (!members.length || !members.every((p) => room.players[p].bot)) continue;
      if (room.ready[tk(team)] || botPlacing[team]) continue;
      botPlacing[team] = true;
      setTimeout(async () => {
        try {
          await update(roomRef(currentRoomCode), { [`fleets/${tk(team)}`]: randomFleet() });
          await markReady(team, members[0]);
        } catch { /* retried on the next room update */ } finally { botPlacing[team] = false; }
      }, 700 + Math.random() * 600);
    }
  } else if (room.status === 'playing' && room.game) {
    const cur = currentPid(room);
    const moveNo = room.game.moveNo;
    if (!room.players[cur]?.bot || botMoveFor === moveNo) return;
    botMoveFor = moveNo;
    clearTimeout(botTimer);
    botTimer = setTimeout(() => botMove(cur, moveNo), 1100 + Math.random() * 900);
  }
}

async function botMove(pid, moveNo) {
  const room = latestRoom;
  if (!room || room.status !== 'playing' || room.game.moveNo !== moveNo || currentPid(room) !== pid) return;
  const bot = room.players[pid];
  const target = 1 - bot.team;
  const pick = botPick(bot.level || 'medium', fleetOf(room, target), room.game.shots[tk(target)]);
  try {
    if (pick) await sendShot(pick[0], pick[1], pid);
  } catch {
    botMoveFor = null;
    setTimeout(driveBots, 1500);
  }
}

// ---------------------------------------------------------------- game
let aim = null;            // {x,y} the local player has tapped but not fired yet
let firing = false;
let lastMoveNo = null;
let wasMyTurn = false;
let popPending = false;
let overTimer = null;
let overShownKey = null;

function resetRoundFx() {
  botMoveFor = null; clearTimeout(botTimer);
  aim = null; firing = false; lastMoveNo = null; wasMyTurn = false; popPending = false;
  clearTimeout(overTimer); overShownKey = null;
}

function resetGameFx() {
  aim = null; firing = false; lastMoveNo = null; wasMyTurn = false; popPending = false;
  clearTimeout(overTimer); overShownKey = null;
  selectedItem = null;
}

function fleetChips(fleet, shots, enemy) {
  return SHIPS.map((s) => {
    const sunk = isSunk(fleet, shots, s.id);
    const hits = enemy ? (sunk ? s.len : 0) : shipHits(fleet, shots, s.id);
    const pips = Array.from({ length: s.len }, (_, i) => `<span class="pip${i < hits ? ' x' : ''}"></span>`).join('');
    return `<span class="chip${sunk ? ' sunk' : ''}">${s.name}<span class="pips">${pips}</span></span>`;
  }).join('');
}

function renderGame() {
  const room = latestRoom;
  const g = room.game;
  if (!g) return;
  const team = myTeam();
  const enemy = 1 - team;
  const over = room.status === 'over';
  const cur = currentPid(room);
  const myTurn = !over && cur === playerId;

  // ---- one-shot effects when a new move arrives
  if (g.moveNo !== lastMoveNo) {
    if (lastMoveNo !== null && g.last) onMove(room, g.last);
    lastMoveNo = g.moveNo;
    firing = false;
    aim = null;
  }
  if (myTurn && !wasMyTurn && lastMoveNo !== null) { play('turn', 0.9); if (navigator.vibrate) navigator.vibrate([60, 40, 60]); }
  wasMyTurn = myTurn;

  const enemyFleet = fleetOf(room, enemy);
  const ownFleet = fleetOf(room, team);
  const enemyShots = g.shots[tk(enemy)];
  const ownShots = g.shots[tk(team)];   // shots the enemy has fired at us

  // ---- banner
  const banner = $('turn-banner');
  const curTeam = cur ? room.players[cur]?.team : team;
  banner.style.setProperty('--tc', TEAMS[over ? g.winner : curTeam].color);
  banner.classList.toggle('mine', myTurn);
  if (over) banner.textContent = `🏴‍☠️ ${TEAMS[g.winner].name} win!`;
  else if (myTurn) banner.textContent = '⚓ Your turn, Captain!';
  else banner.textContent = `${TEAMS[curTeam].emoji} ${playerName(room, cur)}'s turn`;

  // ---- enemy waters
  const sunkCells = new Set();
  for (const id of sunkShipIds(enemyFleet, enemyShots)) {
    for (const [x, y] of itemCells(itemById(id), enemyFleet[id])) sunkCells.add(`${x},${y}`);
  }
  const enemyMap = cellMap(enemyFleet);
  const last = g.last;
  const lastOnEnemy = last && last.team === team;
  $('enemy-grid').innerHTML = gridShell((x, y) => {
    const v = enemyShots[shotKey(x, y)];
    const cls = ['cell'];
    if (v === MISS) cls.push('miss', 'static');
    else if (v === HIT) cls.push('hit', 'static', sunkCells.has(`${x},${y}`) ? 'sunk' : '');
    else if (v === LOOT) cls.push('loot', 'static');
    else if (over && enemyMap.has(`${x},${y}`)) cls.push('reveal', 'static', itemById(enemyMap.get(`${x},${y}`).id).kind === 'chest' ? 'chest' : '');
    else if (aim && aim.x === x && aim.y === y) cls.push('aim');
    if (v && lastOnEnemy && last.x === x && last.y === y) { cls.push('last'); if (popPending) cls.push('pop'); }
    return `<button class="cell ${cls.join(' ')}" data-x="${x}" data-y="${y}" aria-label="${coordName(x, y)}"></button>`;
  });
  $('enemy-title').textContent = `${TEAMS[enemy].emoji} ${TEAMS[enemy].name} waters`;
  $('enemy-loot').textContent = `💰 ${lootedCount(enemyFleet, enemyShots)}/3 looted`;
  $('enemy-status').innerHTML = fleetChips(enemyFleet, enemyShots, true);

  // ---- own fleet
  const ownMap = cellMap(ownFleet);
  const ownSunk = new Set();
  for (const id of sunkShipIds(ownFleet, ownShots)) {
    for (const [x, y] of itemCells(itemById(id), ownFleet[id])) ownSunk.add(`${x},${y}`);
  }
  $('own-grid').innerHTML = gridShell((x, y) => {
    const v = ownShots[shotKey(x, y)];
    const cls = ['cell', 'static', boardCellClasses(ownFleet, ownMap, x, y)];
    if (v === MISS) cls.push('miss');
    else if (v === HIT) cls.push('hit', ownSunk.has(`${x},${y}`) ? 'sunk' : '');
    else if (v === LOOT) cls.push('loot');
    if (v && last && last.team !== team && last.x === x && last.y === y) { cls.push('last'); if (popPending) cls.push('pop'); }
    return `<div class="${cls.join(' ')}"></div>`;
  });
  $('own-title').textContent = `Your fleet${Object.values(room.players).filter((p) => p.team === team).length > 1 ? ' (shared)' : ''}`;
  $('own-loot').textContent = `💰 ${lootedCount(ownFleet, ownShots)}/3 lost`;
  $('own-status').innerHTML = fleetChips(ownFleet, ownShots, false);
  popPending = false;

  // ---- fire button
  const fire = $('fire-btn');
  if (over) { fire.textContent = 'Game over'; fire.disabled = true; }
  else if (myTurn) {
    fire.disabled = !aim || firing;
    fire.textContent = aim ? `🔥 FIRE at ${coordName(aim.x, aim.y)}!` : 'Tap a square to aim';
  } else {
    fire.disabled = true;
    fire.textContent = `Waiting for ${playerName(room, cur)}…`;
  }

  // ---- game over modal (delayed so everyone sees the final shot land)
  if (over) {
    const key = `${currentRoomCode}:${g.moveNo}`;
    if (overShownKey !== key) {
      overShownKey = key;
      clearTimeout(overTimer);
      overTimer = setTimeout(showOver, 2600);
    }
  } else { hide($('over-modal')); overShownKey = null; clearTimeout(overTimer); }

  tickTimer();
}

function onMove(room, last) {
  popPending = true;
  const name = playerName(room, last.pid);
  const coord = coordName(last.x, last.y);
  const item = last.itemId ? itemById(last.itemId) : null;
  play('fire');
  if (last.res === MISS) {
    play('splash', 0.35);
    shoutout(`💦 ${name}: splash at ${coord}`, '#7fd0ff', 1500);
  } else if (last.res === LOOT) {
    play('chest', 0.35);
    shoutout(`💰 ${name} looted treasure at ${coord}! Fire again!`, '#f2c14e', 2300);
  } else if (last.sunk) {
    play('sunk', 0.35);
    shoutout(`☠️ ${item ? item.name : 'Ship'} sunk by ${name}!`, '#ff6b52', 2400);
  } else {
    play('hit', 0.35);
    shoutout(`🔥 ${name}: hit at ${coord}!`, '#ff9a4f', 1700);
  }
  if (navigator.vibrate && last.pid !== playerId && last.res !== MISS) navigator.vibrate(120);
}

$('enemy-grid').addEventListener('click', (e) => {
  const c = e.target.closest('.cell');
  if (!c || !latestRoom || latestRoom.status !== 'playing') return;
  if (currentPid(latestRoom) !== playerId) { toast("It's not your turn yet"); return; }
  const x = Number(c.dataset.x), y = Number(c.dataset.y);
  const enemyShots = latestRoom.game.shots[tk(1 - myTeam())];
  if (enemyShots[shotKey(x, y)]) return;
  aim = { x, y };
  renderGame();
});

$('fire-btn').addEventListener('click', async () => {
  if (!aim || firing || !latestRoom || latestRoom.status !== 'playing') return;
  if (currentPid(latestRoom) !== playerId) return;
  firing = true;
  $('fire-btn').disabled = true;
  const { x, y } = aim;
  try {
    const ok = await sendShot(x, y);
    if (!ok) { firing = false; toast('That shot did not go through'); renderGame(); }
  } catch { firing = false; toast('Connection trouble — try again'); renderGame(); }
});

// Fires `asPid`'s shot inside a transaction so a double-tap (or a timeout fallback racing
// the real player) can never fire twice.
async function sendShot(x, y, asPid = playerId) {
  const res = await runTransaction(roomRef(currentRoomCode), (cur) => {
    if (!cur) return cur;
    try {
      const next = applyShot(normalizeRoom(cur), asPid, x, y);
      next.turnStartedAt = serverTimestamp();
      return next;
    } catch { return; }
  });
  return res.committed;
}

// ---------------------------------------------------------------- turn timer
function tickTimer() {
  const room = latestRoom;
  const el = $('turn-timer');
  const secs = room?.settings?.turnSeconds || 0;
  if (!room || room.status !== 'playing' || !secs || !room.turnStartedAt) { hide(el); return; }
  const rem = Math.ceil(secs - (serverNow() - room.turnStartedAt) / 1000);
  const cur = currentPid(room);
  const mine = cur === playerId;
  show(el);
  el.textContent = String(Math.max(0, rem));
  el.classList.toggle('mine', mine);
  el.classList.toggle('urgent', rem <= 5 && rem > 0);
  if (mine && rem > 0 && rem <= 5) play('tick');

  // Out of time: the stalled player's own client fires right away; anyone else steps in
  // after a grace period (there is no server to do it for us on the free plan).
  if (!autoBusy && cur && (rem <= 0 && (mine || rem <= -6))) autoShoot(room, cur);
}

async function autoShoot(room, pid) {
  autoBusy = true;
  try {
    const team = room.players[pid]?.team;
    if (team == null) return;
    const target = 1 - team;
    const pick = pickShot(fleetOf(room, target), room.game.shots[tk(target)]);
    if (pick) await sendShot(pick[0], pick[1], pid);
  } catch { /* try again next tick */ } finally { autoBusy = false; }
}

// ---------------------------------------------------------------- game over
function showOver() {
  const room = latestRoom;
  if (!room || room.status !== 'over' || !room.game) return;
  const g = room.game;
  const team = myTeam();
  const won = g.winner === team;
  $('over-emoji').textContent = won ? '🏴‍☠️' : '🌊';
  $('over-title').textContent = won ? 'Victory!' : 'Your fleet sleeps with the fishes';
  $('over-sub').textContent = `${TEAMS[g.winner].name} sank every ship.`;
  const myLoot = lootedCount(fleetOf(room, 1 - team), g.shots[tk(1 - team)]);
  const theirLoot = lootedCount(fleetOf(room, team), g.shots[tk(team)]);
  const shotsFired = Object.keys(g.shots[tk(1 - team)]).length;
  $('over-stats').innerHTML = `<div>💰 You looted ${myLoot}/3</div><div>🎯 ${shotsFired} shots</div><div>💰 They looted ${theirLoot}/3</div>`;
  const host = isHost();
  (host ? show : hide)($('over-again'));
  (host ? hide : show)($('over-wait'));
  show($('over-modal'));
  play(won ? 'win' : 'lose');
}
$('over-view').addEventListener('click', () => hide($('over-modal')));
$('over-again').addEventListener('click', async () => {
  await update(roomRef(currentRoomCode), { status: 'lobby', game: null, fleets: null, ready: null, turnStartedAt: null });
});

// ---------------------------------------------------------------- boot
async function boot() {
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  const saved = store.get('plunderbay_room');
  if (saved && saved !== urlRoom) {
    try {
      const snap = await get(roomRef(saved));
      if (snap.exists() && snap.val().players?.[playerId]) { enterRoom(saved); return; }
    } catch { /* fall through */ }
    store.del('plunderbay_room');
  }
  if (urlRoom) {
    $('join-code').value = urlRoom;
    $('join-name').value = myName;
    showScreen('screen-join');
    if (saved === urlRoom) {
      try {
        const snap = await get(roomRef(saved));
        if (snap.exists() && snap.val().players?.[playerId]) enterRoom(saved);
      } catch { /* stay on join screen */ }
    }
    return;
  }
  showScreen('screen-home');
}
boot();
