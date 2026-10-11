// Plunder Bay — pure game engine (no DOM, no Firebase). Everything here takes plain
// objects and returns plain objects so the same code runs in the browser and in
// scripts/engine-tests.mjs.
//
// Shapes
//   fleet  = { galleon:{x,y,h}, frigate:{...}, ..., c0:{x,y,h}, c1, c2 }   (h: 1 = runs right, 0 = runs down)
//   shots  = { "3_4": 1|2|3 }   1 = miss, 2 = ship hit, 3 = treasure looted
//   room   = { status, players:{pid:{name,team,seat,left}}, fleets:{t0,t1}, ready:{t0,t1},
//              game:{ order:[pid], turn, moveNo, shots:{t0,t1}, last, winner } }
// Team keys are 't0'/'t1' (not 0/1) because Firebase turns integer-keyed objects into arrays.

export const SIZE = 10;
export const COLS = 'ABCDEFGHIJ';

export const SHIPS = [
  { id: 'galleon', name: 'Galleon', len: 5, kind: 'ship' },
  { id: 'frigate', name: 'Frigate', len: 4, kind: 'ship' },
  { id: 'brig', name: 'Brig', len: 3, kind: 'ship' },
  { id: 'sloop', name: 'Sloop', len: 3, kind: 'ship' },
  { id: 'dinghy', name: 'Dinghy', len: 2, kind: 'ship' },
];
export const CHESTS = [
  { id: 'c0', name: 'Treasure', len: 1, kind: 'chest' },
  { id: 'c1', name: 'Treasure', len: 1, kind: 'chest' },
  { id: 'c2', name: 'Treasure', len: 1, kind: 'chest' },
];
export const ITEMS = [...SHIPS, ...CHESTS];
export const itemById = (id) => ITEMS.find((i) => i.id === id);

export const tk = (team) => 't' + team;
export const shotKey = (x, y) => `${x}_${y}`;
export const coordName = (x, y) => `${COLS[x]}${y + 1}`;

export const MISS = 1;
export const HIT = 2;
export const LOOT = 3;

// ------------------------------------------------------------------ fleet building
export function itemCells(item, pos) {
  const out = [];
  for (let i = 0; i < item.len; i++) out.push(pos.h ? [pos.x + i, pos.y] : [pos.x, pos.y + i]);
  return out;
}

// key "x,y" -> { id, idx } for every occupied cell
export function cellMap(fleet, skipId = null) {
  const m = new Map();
  for (const item of ITEMS) {
    const pos = fleet[item.id];
    if (!pos || item.id === skipId) continue;
    itemCells(item, pos).forEach(([x, y], idx) => m.set(`${x},${y}`, { id: item.id, idx }));
  }
  return m;
}

export function fits(fleet, id, x, y, h) {
  const item = itemById(id);
  const occupied = cellMap(fleet, id);
  for (const [cx, cy] of itemCells(item, { x, y, h })) {
    if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) return false;
    if (occupied.has(`${cx},${cy}`)) return false;
  }
  return true;
}

// Returns a new fleet with the item placed, or null if it doesn't fit.
export function placeItem(fleet, id, x, y, h) {
  const hh = h ? 1 : 0;
  if (!fits(fleet, id, x, y, hh)) return null;
  return { ...fleet, [id]: { x, y, h: hh } };
}

export function isComplete(fleet) {
  return !!fleet && ITEMS.every((i) => fleet[i.id]);
}

export function randomFleet(rng = Math.random) {
  for (let attempt = 0; attempt < 200; attempt++) {
    let fleet = {};
    let ok = true;
    for (const item of ITEMS) {
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries++) {
        const h = item.len === 1 ? 1 : (rng() < 0.5 ? 1 : 0);
        const x = Math.floor(rng() * (SIZE - (h ? item.len : 1) + 1));
        const y = Math.floor(rng() * (SIZE - (h ? 1 : item.len) + 1));
        const next = placeItem(fleet, item.id, x, y, h);
        if (next) { fleet = next; placed = true; }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return fleet;
  }
  throw new Error('could not build a random fleet');
}

// ------------------------------------------------------------------ shooting
export function shipHits(fleet, shots, id) {
  const item = itemById(id);
  const pos = fleet[id];
  if (!pos) return 0;
  return itemCells(item, pos).filter(([x, y]) => shots[shotKey(x, y)]).length;
}

export function isSunk(fleet, shots, id) {
  const item = itemById(id);
  return !!fleet[id] && shipHits(fleet, shots, id) === item.len;
}

export function sunkShipIds(fleet, shots) {
  return SHIPS.filter((s) => isSunk(fleet, shots, s.id)).map((s) => s.id);
}

export function allShipsSunk(fleet, shots) {
  return SHIPS.every((s) => isSunk(fleet, shots, s.id));
}

export function lootedCount(fleet, shots) {
  return CHESTS.filter((c) => fleet[c.id] && shots[shotKey(fleet[c.id].x, fleet[c.id].y)]).length;
}

// Evaluate a shot at (x,y) against `fleet`. `shots` must NOT yet contain this cell.
export function evalShot(fleet, shots, x, y) {
  const hit = cellMap(fleet).get(`${x},${y}`);
  if (!hit) return { res: MISS, itemId: null, sunk: false };
  const item = itemById(hit.id);
  if (item.kind === 'chest') return { res: LOOT, itemId: hit.id, sunk: false };
  const after = { ...shots, [shotKey(x, y)]: HIT };
  return { res: HIT, itemId: hit.id, sunk: isSunk(fleet, after, hit.id) };
}

// ------------------------------------------------------------------ turn order
export function teamPlayers(room, team) {
  return Object.entries(room.players || {})
    .filter(([, p]) => p.team === team)
    .sort((a, b) => a[1].seat - b[1].seat)
    .map(([pid]) => pid);
}

// Alternates teams, rotating through each team's members: A1, B1, A2, B2, ...
export function buildOrder(room, firstTeam = 0) {
  const a = teamPlayers(room, firstTeam);
  const b = teamPlayers(room, 1 - firstTeam);
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

export const toArr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : Object.values(v || {}));

export function currentPid(room) {
  const g = room.game;
  if (!g) return null;
  const order = toArr(g.order);
  return order.length ? order[g.turn % order.length] : null;
}

export function seatsPerTeam(mode) { return mode === 4 ? 2 : 1; }

// First open seat, filling team 0 seat 0, team 1 seat 0, team 0 seat 1, team 1 seat 1.
export function findFreeSeat(room) {
  const per = seatsPerTeam(room.settings?.mode || 2);
  const taken = new Set(Object.values(room.players || {}).map((p) => `${p.team}:${p.seat}`));
  for (let seat = 0; seat < per; seat++) {
    for (let team = 0; team < 2; team++) {
      if (!taken.has(`${team}:${seat}`)) return { team, seat };
    }
  }
  return null;
}

export function lobbyReady(room) {
  const per = seatsPerTeam(room.settings?.mode || 2);
  return Object.keys(room.players || {}).length === per * 2;
}

// ------------------------------------------------------------------ game start + shot application
// Called inside a transaction when both crews are ready.
export function startGame(room, firstTeam) {
  const order = buildOrder(room, firstTeam);
  return {
    ...room,
    status: 'playing',
    game: {
      order,
      turn: 0,
      moveNo: 0,
      shots: { t0: {}, t1: {} },
      last: null,
      winner: null,
    },
  };
}

export function applyShot(room, pid, x, y) {
  if (room.status !== 'playing' || !room.game) throw new Error('Game is not in progress');
  const g = room.game;
  const order = toArr(g.order);
  if (currentPid(room) !== pid) throw new Error('Not your turn');
  if (!(x >= 0 && y >= 0 && x < SIZE && y < SIZE)) throw new Error('Off the map');
  const me = room.players[pid];
  if (!me) throw new Error('Unknown player');
  const target = 1 - me.team;
  const targetShots = g.shots?.[tk(target)] || {};
  if (targetShots[shotKey(x, y)]) throw new Error('Already fired there');

  const fleet = room.fleets?.[tk(target)] || {};
  const { res, itemId, sunk } = evalShot(fleet, targetShots, x, y);
  const newShots = { ...targetShots, [shotKey(x, y)]: res };
  const won = allShipsSunk(fleet, newShots);

  // A looted chest earns another shot; everything else passes the turn (skipping
  // anyone who has left the room).
  let turn = g.turn;
  if (!won && res !== LOOT) {
    for (let i = 1; i <= order.length; i++) {
      const cand = (g.turn + i) % order.length;
      turn = cand;
      if (!room.players[order[cand]]?.left) break;
    }
  }

  return {
    ...room,
    status: won ? 'over' : 'playing',
    game: {
      ...g,
      shots: { ...g.shots, [tk(target)]: newShots },
      turn,
      moveNo: (g.moveNo || 0) + 1,
      last: { pid, team: me.team, x, y, res, itemId: itemId || '', sunk: !!sunk },
      winner: won ? me.team : null,
    },
  };
}

// ------------------------------------------------------------------ auto-shot (turn-timer fallback)
// Prefers cells next to hits on ships that aren't sunk yet; otherwise a checkerboard cell.
export function pickShot(fleet, shots, rng = Math.random) {
  const open = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!shots[shotKey(x, y)]) open.push([x, y]);
  if (!open.length) return null;
  const sunk = new Set(sunkShipIds(fleet, shots));
  const map = cellMap(fleet);
  const hunt = [];
  for (const [x, y] of open) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (shots[shotKey(nx, ny)] === HIT) {
        const owner = map.get(`${nx},${ny}`);
        if (owner && !sunk.has(owner.id)) { hunt.push([x, y]); break; }
      }
    }
  }
  const pool = hunt.length ? hunt : (open.filter(([x, y]) => (x + y) % 2 === 0).length ? open.filter(([x, y]) => (x + y) % 2 === 0) : open);
  return pool[Math.floor(rng() * pool.length)];
}

// ------------------------------------------------------------------ bots
// Bots only use what a human could see: the shot grid, plus which ships are already sunk.
export const BOT_LEVELS = ['easy', 'medium', 'hard'];

function openCells(shots) {
  const open = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!shots[shotKey(x, y)]) open.push([x, y]);
  return open;
}

// Hit squares that belong to a ship that is not sunk yet.
function unresolvedHits(fleet, shots) {
  const sunk = new Set(sunkShipIds(fleet, shots));
  const map = cellMap(fleet);
  const out = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (shots[shotKey(x, y)] !== HIT) continue;
    const owner = map.get(`${x},${y}`);
    if (owner && !sunk.has(owner.id)) out.push([x, y]);
  }
  return out;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const pickOne = (arr, rng) => arr[Math.floor(rng() * arr.length)];

function huntTargets(hits, shots, lineOnly) {
  const hitSet = new Set(hits.map(([x, y]) => `${x},${y}`));
  const out = new Map();
  for (const [hx, hy] of hits) {
    for (const [dx, dy] of DIRS) {
      const x = hx + dx, y = hy + dy;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || shots[shotKey(x, y)]) continue;
      const continuesLine = hitSet.has(`${hx - dx},${hy - dy}`);
      if (lineOnly && !continuesLine) continue;
      out.set(`${x},${y}`, [x, y]);
    }
  }
  return [...out.values()];
}

// Probability-density search: count every way the remaining ships could still fit.
function densityPick(fleet, shots, rng) {
  const sunk = new Set(sunkShipIds(fleet, shots));
  const remaining = SHIPS.filter((s) => !sunk.has(s.id));
  const map = cellMap(fleet);
  const hitSet = new Set(unresolvedHits(fleet, shots).map(([x, y]) => `${x},${y}`));
  const blocked = (x, y) => {
    const v = shots[shotKey(x, y)];
    if (v === MISS || v === LOOT) return true;
    if (v === HIT) { const o = map.get(`${x},${y}`); return !!o && sunk.has(o.id); }
    return false;
  };
  const score = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
  for (const ship of remaining) {
    for (const h of [1, 0]) {
      for (let y = 0; y < SIZE - (h ? 0 : ship.len - 1); y++) {
        for (let x = 0; x < SIZE - (h ? ship.len - 1 : 0); x++) {
          const cells = itemCells(ship, { x, y, h });
          if (cells.some(([cx, cy]) => blocked(cx, cy))) continue;
          const covered = cells.filter(([cx, cy]) => hitSet.has(`${cx},${cy}`)).length;
          const w = covered ? 30 * covered : 1;
          for (const [cx, cy] of cells) score[cy][cx] += w;
        }
      }
    }
  }
  let best = -1, ties = [];
  for (const [x, y] of openCells(shots)) {
    const s = score[y][x];
    if (s > best) { best = s; ties = [[x, y]]; } else if (s === best) ties.push([x, y]);
  }
  return pickOne(ties, rng);
}

export function botPick(level, fleet, shots, rng = Math.random) {
  const open = openCells(shots);
  if (!open.length) return null;
  if (level === 'hard') return densityPick(fleet, shots, rng);
  const hits = unresolvedHits(fleet, shots);
  if (level === 'medium') {
    if (hits.length) {
      const line = hits.length > 1 ? huntTargets(hits, shots, true) : [];
      const pool = line.length ? line : huntTargets(hits, shots, false);
      if (pool.length) return pickOne(pool, rng);
    }
    const parity = open.filter(([x, y]) => (x + y) % 2 === 0);
    return pickOne(parity.length ? parity : open, rng);
  }
  // easy: usually random, sometimes follows up on a hit
  if (hits.length && rng() < 0.5) {
    const pool = huntTargets(hits, shots, false);
    if (pool.length) return pickOne(pool, rng);
  }
  return pickOne(open, rng);
}
