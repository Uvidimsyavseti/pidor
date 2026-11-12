import assert from 'node:assert/strict';
import { PidorGame } from './gameLogic.ts';
import { visibleState } from './visibility.ts';
import { rememberAction, STATE_CHANGING_ACTIONS } from './actionReplay.ts';
import { initialCardCount, makeInitialDealSteps, initialDealDuration } from '../shared/initialDeal.ts';

function cardCount(game) {
  const state = game.state;
  const cards = [
    ...state.deck, ...state.discardPile, ...state.currentTrick,
    ...(state.activeCard ? [state.activeCard.card] : []),
    ...state.players.flatMap(p => [...p.stumps, ...p.hand])
  ];
  assert.equal(cards.length, 36, 'The game always contains 36 cards');
  assert.equal(new Set(cards.map(c => c.id)).size, 36, 'Card identities never duplicate');
}

for (const underlaid of [true, false]) {
  for (const seats of [2, 6]) {
    const players = Array.from({ length: seats }, (_, n) => ({
      id: 'p' + n, name: 'Игрок ' + n
    }));
    const game = new PidorGame(players);
    game.start(underlaid);
    const baseline = underlaid ? 3 : 1;
    assert.equal(initialCardCount(underlaid), baseline);
    assert.equal(game.state.deck.length, 36 - seats * baseline);
    assert.ok(game.state.initialDealAt > 0);
    assert.equal(
      game.state.initialDealEndsAt - game.state.initialDealAt,
      initialDealDuration(seats, underlaid)
    );
    for (const p of game.state.players) {
      assert.equal(p.stumps.length, baseline);
      assert.equal(game.canMoveTopCard(p.id), false,
        'The first visible card cannot be lifted in either mode');
      assert.equal(game.takeFromPile(p.id, p.stumps.at(-1).id), false);
      assert.equal(game.moveTopTo(p.id, game.state.players[(game.state.players.indexOf(p)+1)%seats].id), false);
      const view = visibleState(game.state, players[(game.state.players.indexOf(p)+1)%seats].id);
      const displayed = view.players.find(x => x.id === p.id).stumps;
      assert.equal(displayed.at(-1).id, p.stumps.at(-1).id,
        'The top starter is public and face-up');
      assert.ok(displayed.slice(0,-1).every(card => card.id.startsWith('masked-')),
        'Only the two underlaid cards (if any) are hidden');
    }
    const steps = makeInitialDealSteps(players.map(p => p.id), underlaid);
    assert.equal(steps.length, seats * baseline);
    assert.deepEqual(steps.slice(0,seats).map(step => step.playerId),
      players.map(p => p.id), 'Deal goes clockwise around seats');
    assert.equal(steps.filter(step => step.faceUp).length, seats,
      'Each player gets exactly one face-up original card');
    assert.equal(steps.filter(step => !step.faceUp).length,
      underlaid ? seats*2 : 0);
    cardCount(game);
  }
}

// Invalid draw destinations must not consume the communal deck or orphan a card.
{
  const game = new PidorGame([{id:'p1',name:'P1'},{id:'p2',name:'P2'}]);
  game.start(false);
  const before = game.snapshot();
  const topId = game.state.deck.at(-1).id;
  assert.equal(game.drawTo('p1','nonexistent'),false);
  assert.equal(game.state.deck.at(-1).id,topId);
  assert.equal(game.state.deck.length,before.state.deck.length);
  assert.equal(game.state.activeCard,null);
  assert.equal(game.state.lastDrawEvent,undefined);
  assert.equal(game.drawTo('nonexistent','p2'),false);
  cardCount(game);
}
// Moving a pile top to its OWN pile is not a legal way to skip a turn.
{
  const game=new PidorGame([{id:'p1',name:'P1'},{id:'p2',name:'P2'}]);
  game.start(false);
  const top = game.state.deck.pop();
  game.state.players[0].stumps.push(top);
  const pile = game.state.players[0].stumps.map(c => c.id);
  const current = game.state.turnIndex;
  assert.equal(game.canMoveTopCard('p1'),true);
  assert.equal(game.moveTopTo('p1','p1'),false);
  assert.deepEqual(game.state.players[0].stumps.map(c => c.id),pile,
    'A rejected move restores the original top card');
  assert.equal(game.state.activeCard,null);
  assert.equal(game.state.turnIndex,current);
  cardCount(game);
}

// A client cannot replay a previously applied mutation, even after reconnect.
{
  const history={};
  assert.equal(rememberAction(history,'p1','req_123456789'),true);
  assert.equal(rememberAction(history,'p1','req_123456789'),false);
  assert.equal(rememberAction(history,'p2','req_123456789'),true);
  assert.equal(rememberAction(history,'p1','bad'),false);
  for(let i=0;i<120;i++) {
    assert.equal(rememberAction(history,'p1','request_'+String(i).padStart(4,'0')),true);
  }
  assert.ok(history.p1.length <= 96, 'Anti-replay storage is bounded');
  assert.ok(STATE_CHANGING_ACTIONS.has('drawCardFromDeck'));
  assert.ok(STATE_CHANGING_ACTIONS.has('playCard'));
  assert.ok(STATE_CHANGING_ACTIONS.has('accusePlayer'));
}
console.log('PASS P0: both start modes (2/6 players), public open tops, protected bases, clockwise deal, 36 unique, atomic invalid drop, no self-transfer, replay prevention');
