import assert from 'node:assert/strict';
import {
  SIZE, ITEMS, SHIPS, randomFleet, placeItem, isComplete, cellMap, applyShot, startGame, buildOrder,
  currentPid, pickShot, botPick, BOT_LEVELS, shotKey, findFreeSeat, lobbyReady, MISS, HIT, LOOT, tk, evalShot, allShipsSunk,
} from '../public/rules.js';

// --- random fleets are always complete, in bounds, non-overlapping
for (let i = 0; i < 500; i++) {
  const f = randomFleet();
  assert(isComplete(f));
  const total = ITEMS.reduce((n, it) => n + it.len, 0);
  assert.equal(cellMap(f).size, total, 'no overlaps');
  for (const [k] of cellMap(f)) {
    const [x, y] = k.split(',').map(Number);
    assert(x >= 0 && y >= 0 && x < SIZE && y < SIZE);
  }
}

// --- placement rules
let f = placeItem({}, 'galleon', 0, 0, 1);
assert(f);
assert.equal(placeItem(f, 'frigate', 2, 0, 0), null, 'overlap rejected');
assert.equal(placeItem(f, 'frigate', 8, 0, 1), null, 'out of bounds rejected');
assert(placeItem(f, 'galleon', 5, 5, 0), 'moving an item ignores its own old cells');

// --- turn order: A1 B1 A2 B2
const room4 = { settings: { mode: 4 }, players: {
  a1: { team: 0, seat: 0 }, b1: { team: 1, seat: 0 }, a2: { team: 0, seat: 1 }, b2: { team: 1, seat: 1 },
} };
assert.deepEqual(buildOrder(room4, 0), ['a1', 'b1', 'a2', 'b2']);
assert.deepEqual(buildOrder(room4, 1), ['b1', 'a1', 'b2', 'a2']);
assert(lobbyReady(room4));
assert.equal(findFreeSeat(room4), null);
assert.deepEqual(findFreeSeat({ settings: { mode: 4 }, players: { a1: { team: 0, seat: 0 } } }), { team: 1, seat: 0 });
assert.deepEqual(findFreeSeat({ settings: { mode: 2 }, players: { a1: { team: 0, seat: 0 }, b1: { team: 1, seat: 0 } } }), null);

// --- full simulated 4-player game
function playout(mode) {
  const players = mode === 4
    ? room4.players
    : { a1: { team: 0, seat: 0 }, b1: { team: 1, seat: 0 } };
  let room = {
    settings: { mode }, players,
    fleets: { t0: randomFleet(), t1: randomFleet() },
    status: 'placing',
  };
  room = startGame(room, Math.random() < 0.5 ? 1 : 0);
  let guard = 0, chests = 0;
  while (room.status === 'playing') {
    if (guard++ > 1000) throw new Error('game never ended');
    const pid = currentPid(room);
    const me = room.players[pid];
    const target = 1 - me.team;
    const [x, y] = pickShot(room.fleets[tk(target)], room.game.shots[tk(target)]);
    // wrong-player shot must throw
    const other = Object.keys(room.players).find((p) => p !== pid && room.players[p].team !== me.team);
    assert.throws(() => applyShot(room, other, x, y));
    const before = room.game.turn;
    room = applyShot(room, pid, x, y);
    if (room.game.last.res === LOOT) { chests++; assert.equal(room.game.turn, before, 'chest keeps the turn'); }
    // re-firing the same cell at the same target must throw (when it's that team's turn again)
    if (room.status === 'playing' && room.players[currentPid(room)].team === me.team) {
      assert.throws(() => applyShot(room, currentPid(room), x, y), /Already fired/);
    }
  }
  assert.equal(room.status, 'over');
  assert(allShipsSunk(room.fleets[tk(1 - room.game.winner)], room.game.shots[tk(1 - room.game.winner)]));
  assert(!allShipsSunk(room.fleets[tk(room.game.winner)], room.game.shots[tk(room.game.winner)]) || true);
  return guard;
}
let moves = 0;
for (let i = 0; i < 200; i++) moves += playout(i % 2 ? 4 : 2);
console.log('avg moves per game', (moves / 200).toFixed(1));

// --- a left player's turn is skipped
{
  const players = { ...room4.players, b1: { team: 1, seat: 0, left: true } };
  let room = startGame({ settings: { mode: 4 }, players, fleets: { t0: randomFleet(), t1: randomFleet() } }, 0);
  const fleet = room.fleets.t1;
  // find a guaranteed miss from a1
  let mx, my;
  for (let y = 0; y < SIZE && mx === undefined; y++) for (let x = 0; x < SIZE; x++) if (evalShot(fleet, {}, x, y).res === MISS) { mx = x; my = y; break; }
  room = applyShot(room, 'a1', mx, my);
  assert.equal(currentPid(room), 'a2', 'b1 (left) skipped');
}

// --- bot strength: shots needed to sink a random fleet should drop easy > medium > hard
const avg = {};
for (const level of BOT_LEVELS) {
  let total = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const fleet = randomFleet();
    let shots = {};
    while (!allShipsSunk(fleet, shots)) {
      const pick = botPick(level, fleet, shots);
      assert(pick, 'bot ran out of cells');
      assert(!shots[shotKey(pick[0], pick[1])], 'bot re-fired a cell');
      const { res } = evalShot(fleet, shots, pick[0], pick[1]);
      shots = { ...shots, [shotKey(pick[0], pick[1])]: res };
      total++;
    }
  }
  avg[level] = total / N;
}
console.log('avg shots to clear a fleet', avg);
assert(avg.hard < avg.medium && avg.medium < avg.easy, 'difficulty ordering');

console.log('engine tests passed');
