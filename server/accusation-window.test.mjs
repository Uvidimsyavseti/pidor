import assert from 'node:assert/strict';
import { PidorGame, VIOLATION_WINDOW_MS } from './gameLogic.ts';

const originalNow = Date.now;
try {
  let now = 1_900_000_000_000;
  Date.now = () => now;
  const game = new PidorGame([
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
    { id: 'carl', name: 'Carl' }
  ]);
  game.start();
  const alice = game.state.players[0];
  const bob = game.state.players[1];

  // No foul is awarded by the engine without another player's accusation.
  game.addPenalty(0, 'Сыграл вне очереди');
  assert.equal(alice.penalties, 0, 'Unnoticed cheating must not receive a fine');
  assert.deepEqual(game.accusableTargets('bob'), ['alice']);

  // The last possible millisecond within the 15-second window is valid.
  now += VIOLATION_WINDOW_MS - 1;
  const onTime = game.accuse('bob', 'alice');
  assert.equal(onTime?.correct, true);
  assert.equal(onTime?.penalizedId, 'alice');
  assert.equal(alice.penalties, 1);
  assert.equal(bob.penalties, 0);

  // Subsequent violation after the first one has been resolved.
  now += 10_000;
  game.addPenalty(0, 'Пропустил младшую карту');
  assert.equal(alice.penalties, 1);
  now += VIOLATION_WINDOW_MS;
  assert.deepEqual(game.accusableTargets('bob'), [], 'A 15-second old violation is already expired');
  const late = game.accuse('bob', 'alice');
  assert.equal(late?.correct, false, 'Accusation after 15 seconds is false');
  assert.equal(late?.penalizedId, 'bob');
  assert.equal(bob.penalties, 1);
  assert.equal(alice.penalties, 1, 'The successful unnoticed cheat must remain unpunished');

  // A fresh false accusation also penalizes the caller.
  now += 2_000;
  const falseCall = game.accuse('carl', 'bob');
  assert.equal(falseCall?.correct, false);
  assert.equal(falseCall?.penalizedId, 'carl');
  assert.equal(game.state.players[2].penalties, 1);

  console.log('PASS: 15-second accusation deadline, correctly accused cheat, expired cheat, false accusation self-penalty, no automatic fines');
} finally {
  Date.now = originalNow;
}
