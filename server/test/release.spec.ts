
import test from 'node:test';
import assert from 'node:assert/strict';
import { PidorGame, createDeck } from '../gameLogic.ts';
import { visibleState } from '../visibility.ts';
import { rememberAction, STATE_CHANGING_ACTIONS } from '../actionReplay.ts';
import { initialCardCount, makeInitialDealSteps, initialDealDuration } from '../../shared/initialDeal.ts';
import type { Card, GameState } from '../../shared/types.ts';

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'Player ' + i }));

function countCards(state: GameState) {
  return [
    ...state.deck, ...state.discardPile, ...state.currentTrick,
    ...(state.activeCard ? [state.activeCard.card] : []),
    ...state.players.flatMap(p => [...p.stumps, ...p.hand]),
  ];
}
function assertConserved(state: GameState) {
  const cards = countCards(state);
  assert.equal(cards.length, 36, 'exactly 36 cards across every zone');
  assert.equal(new Set(cards.map(card => card.id)).size, 36, 'no duplicate card IDs');
}
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: rank + '_' + suit, rank, suit });

test('whole deck is unique: 9 ranks times 4 suits', () => {
  const deck = createDeck();
  assert.equal(deck.length, 36);
  assert.equal(new Set(deck.map(x => x.id)).size, 36);
});

for (const withUnderlaid of [false, true]) {
  for (const n of [2, 3, 4, 5, 6]) {
    test(`start ${n} players, underlaid=${withUnderlaid}: counts, order and locked first card`, () => {
      const game = new PidorGame(players(n));
      game.start(withUnderlaid);
      assert.equal(game.state.phase, 'DEALING');
      assert.equal(game.state.deck.length, 36 - n * initialCardCount(withUnderlaid));
      assert.deepEqual(game.state.players.map(p => p.stumps.length), Array(n).fill(initialCardCount(withUnderlaid)));
      assert.equal(game.state.trumpSuit, null);
      assert.equal(game.state.activeCard, null);
      for (const p of game.state.players) {
        assert.equal(game.canMoveTopCard(p.id), false);
        assert.equal(game.takeFromPile(p.id, p.stumps[p.stumps.length - 1].id), false, 'original dealt card immovable');
      }
      const steps = makeInitialDealSteps(players(n).map(x => x.id), withUnderlaid);
      assert.equal(steps.length, n * (withUnderlaid ? 3 : 1));
      assert.deepEqual(steps.map(x => x.playerId).slice(0, n), players(n).map(p => p.id));
      assert.equal(steps.at(-1)?.faceUp, true);
      assert.equal(steps[0].faceUp, !withUnderlaid);
      assert.ok(initialDealDuration(n, withUnderlaid) > 0);
      assertConserved(game.state);
    });
  }
}

test('strict adjacent ranks ignore suits in dealing and spade six exception', () => {
  const game = new PidorGame(players(2));
  assert.equal(game.canBeat(card('7','clubs'), card('6','diamonds')), true);
  assert.equal(game.canBeat(card('9','diamonds'), card('7','hearts')), false);
  assert.equal(game.canBeat(card('J','diamonds'), card('10','spades')), true);
  assert.equal(game.canBeat(card('Q','spades'), card('J','clubs')), true);
  assert.equal(game.canBeat(card('K','hearts'), card('Q','diamonds')), true);
  assert.equal(game.canBeat(card('A','spades'), card('K','clubs')), true);
  assert.equal(game.canBeat(card('6','hearts'), card('A','spades')), true);
  assert.equal(game.canBeat(card('6','spades'), card('A','spades')), false);
});

test('a drawn card is an actual unique card, never replaced or duplicated', () => {
  const game = new PidorGame(players(2));
  game.start(false);
  const count = game.state.deck.length;
  assert.equal(game.takeFromDeck('p0'), true);
  assert.equal(game.state.deck.length, count - 1);
  const active = game.state.activeCard;
  if (active) {
    const drawnId = active.card.id;
    assertConserved(game.state);
    assert.equal(game.placeActiveCard('p0', 'p1'), true);
    assert.equal(game.state.players[1].stumps.at(-1)?.id, drawnId);
  }
  assertConserved(game.state);
});

test('intentional violation only penalized if another player accuses', () => {
  const game = new PidorGame(players(3));
  game.start(false);
  game.addPenalty(0, 'Смухлевал', '7_of_hearts');
  assert.equal(game.state.players[0].penalties, 0);
  const verdict = game.accuse('p1','p0');
  assert.ok(verdict?.correct);
  assert.equal(verdict?.penalizedId, 'p0');
  assert.equal(game.state.players[0].penalties, 1);
  assert.equal(game.state.players[1].penalties, 0);
});

test('false accusation penalizes accuser and does not target innocent player', () => {
  const game = new PidorGame(players(2));
  game.start(false);
  const verdict = game.accuse('p1','p0');
  assert.ok(verdict && !verdict.correct);
  assert.equal(game.state.players[1].penalties, 1);
  assert.equal(game.state.players[0].penalties, 0);
});

test('server hides deck and original underlaid cards, reveals only the real top card', () => {
  const game = new PidorGame(players(2));
  game.start(true);
  const publicState = visibleState(game.state,'p0');
  assert.ok(publicState.deck.every(c => c.id.startsWith('masked-')));
  assert.ok(publicState.players.every(p => p.stumps.length === 3));
  for (let i=0; i<2; i++) {
    const original = game.state.players[i].stumps;
    const exposed = publicState.players[i].stumps;
    assert.ok(exposed[0].id.startsWith('masked-'));
    assert.ok(exposed[1].id.startsWith('masked-'));
    assert.equal(exposed[2].id, original[2].id);
  }
  assertConserved(game.state);
});

test('duplicate action IDs are rejected per player and kept bounded', () => {
  const h: Record<string,string[]> = {};
  assert.ok(STATE_CHANGING_ACTIONS.has('drawCardFromDeck'));
  assert.equal(rememberAction(h,'p0','action_12345678'),true);
  assert.equal(rememberAction(h,'p0','action_12345678'),false);
  assert.equal(rememberAction(h,'p1','action_12345678'),true);
  assert.equal(rememberAction(h,'p0','bad'),false);
  for(let i=0;i<140;i++) assert.equal(rememberAction(h,'p0','id_'+String(i).padStart(12,'0')),true);
  assert.equal(h.p0.length,96);
});

test('state restoration preserves card IDs, deck and active card', () => {
  const game = new PidorGame(players(2));
  game.start(true);
  game.takeFromDeck('p0');
  const snapshot = structuredClone(game.snapshot());
  const restored = new PidorGame([]);
  restored.restore(snapshot);
  assert.deepEqual(restored.state, game.state);
  assertConserved(restored.state);
});

test('penalty distribution: server assigns the giver, recipient, exact card and enters MAIN_GAME', () => {
  const game = new PidorGame(players(2));
  game.start(false);
  game.addPenalty(0, 'Проверка мухлежа');
  const verdict = game.accuse('p1', 'p0');
  assert.equal(verdict?.correct, true);
  assert.equal(game.state.players[0].penalties, 1);
  for (let n = 0; game.state.phase === 'DEALING' && n < 40; n++) {
    const actor = game.state.players[game.state.turnIndex];
    assert.equal(game.takeFromDeck(actor.id), true);
    if (game.state.activeCard) assert.equal(game.placeActiveCard(actor.id, actor.id), true);
  }
  assert.equal(game.state.deck.length, 0);
  assert.equal(game.state.phase, 'PENALTY_REVIEW');
  assert.equal(game.finishReview('p0'), true);
  assert.equal(game.finishReview('p1'), true);
  assert.equal(game.state.phase, 'PENALTY_DISTRIBUTION');
  const pending = game.currentPenaltyTurn();
  assert.equal(pending?.giverId, 'p1');
  assert.equal(pending?.receiverId, 'p0');
  const gift = game.state.players[1].hand[0];
  assert.ok(gift);
  assert.equal(game.givePenaltyCard('p1', gift.id, 'p1'), false, 'only server-designated recipient may receive');
  assert.equal(game.givePenaltyCard('p1', gift.id, 'p0'), true);
  assert.equal(game.state.phase, 'MAIN_GAME');
  assert.ok(game.state.players[0].hand.some(c => c.id === gift.id));
  assertConserved(game.state);
});
