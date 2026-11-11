import assert from 'node:assert/strict';
import { PidorGame, VIOLATION_WINDOW_MS } from './gameLogic.ts';

function findAndMoveToDeckTop(game, rank, suit) {
  const state = game.state;
  const final = state.deck.length - 1;
  const replaceWith = state.deck[final];
  const index = state.deck.findIndex(card => card.rank === rank && card.suit === suit);
  if (index >= 0) {
    [state.deck[index], state.deck[final]] = [state.deck[final], state.deck[index]];
    return;
  }
  for (const player of state.players) {
    const i = player.stumps.findIndex(card => card.rank === rank && card.suit === suit);
    if (i >= 0) {
      state.deck[final] = player.stumps[i];
      player.stumps[i] = replaceWith;
      return;
    }
  }
  throw new Error('Requested card is not in deck or stumps');
}

function check36(game) {
  const state = game.state;
  const cards = [...state.deck, ...state.discardPile, ...state.currentTrick,
    ...(state.activeCard ? [state.activeCard.card] : []),
    ...state.players.flatMap(p => [...p.hand, ...p.stumps])];
  assert.equal(cards.length, 36, '36-card conservation');
  assert.equal(new Set(cards.map(card => card.id)).size, 36, 'Unique cards');
}

const originalNow = Date.now;
try {
  let now = 1_900_000_000_000;
  Date.now = () => now;

  const game = new PidorGame([{id:'alice',name:'Alice'}, {id:'bob',name:'Bob'}]);
  game.start();
  assert.equal(game.state.turnIndex, 0);
  const before = game.state.deck.length;
  const nextTop = game.state.deck[before - 1];
  assert.equal(game.takeFromDeck('bob'), true, 'Off-turn draw is allowed');
  assert.equal(game.state.turnIndex, 0, 'The right player retains the turn');
  assert.equal(game.state.deck.length, before - 1);
  assert.equal(game.state.players[1].stumps.at(-1)?.id, nextTop.id, 'Illicit card forced into offender pile');
  assert.equal(game.state.activeCard, null, 'Out-of-turn card cannot be transferred');
  assert.equal(game.state.lastDrawEvent?.playerId, 'bob');
  assert.equal(game.state.lastDrawEvent?.outOfTurn, true);
  assert.equal(game.state.lastDrawEvent?.forcedSelf, true);
  assert.equal(game.state.players[1].penalties, 0, 'Fouls require a manual accusation');
  assert.ok(game.accusableTargets('alice').includes('bob'));
  const accused = game.accuse('alice','bob');
  assert.equal(accused?.correct,true);
  assert.equal(game.state.players[1].penalties, 1);
  check36(game);

  // A spade six always remains with the drawer (even during their legal turn).
  const forced = new PidorGame([{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}]);
  forced.start();
  findAndMoveToDeckTop(forced, '6', 'spades');
  const first = forced.state.deck.length;
  assert.equal(forced.takeFromDeck('alice'),true);
  assert.equal(forced.state.deck.length,first - 1);
  assert.equal(forced.state.activeCard,null,'Spade six is never offered as a target card');
  assert.equal(forced.state.players[0].stumps.at(-1)?.id,'6_of_spades');
  assert.equal(forced.state.lastDrawEvent?.forcedSelf,true);
  assert.equal(forced.state.players[0].penalties,0,'Spade six requires accusation');
  assert.ok(forced.accusableTargets('bob').includes('alice'));
  assert.equal(forced.accuse('bob','alice')?.correct,true);
  check36(forced);

  // Last-card spade means no-trump even if the preceding draw was another suit.
  const finalSpade = new PidorGame([{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}]);
  finalSpade.start();
  finalSpade.state.deck = [{id:'K_of_spades',suit:'spades',rank:'K'}];
  finalSpade.state.trumpSuit = 'hearts';
  assert.equal(finalSpade.takeFromDeck('alice'),true);
  assert.equal(finalSpade.state.trumpSuit,null,'Any last spade means no trump');
  assert.equal(finalSpade.placeActiveCard('alice','alice'),true);

  const c=(rank,suit)=>({id:rank+'_of_'+suit,rank,suit});
  finalSpade.state.trumpSuit = null;
  assert.equal(finalSpade.isLegalMove(c('K','hearts'),c('7','clubs')),false,'No trump beats another suit');
  assert.equal(finalSpade.isLegalMove(c('K','clubs'),c('7','clubs')),true,'Only same suit can beat');
  assert.equal(finalSpade.isLegalMove(c('6','clubs'),c('A','clubs')),true,'6 beats suited A');
  assert.equal(finalSpade.isLegalMove(c('6','hearts'),c('A','clubs')),false,'6 must share ace suit');
  assert.equal(finalSpade.isLegalMove(c('6','spades'),c('A','spades')),true,'Spade 6 beats spade A');
  finalSpade.state.trumpSuit='hearts';
  assert.equal(finalSpade.isLegalMove(c('6','hearts'),c('A','hearts')),true,'Trump-suit 6 beats trump ace');
  assert.equal(finalSpade.isLegalMove(c('K','clubs'),c('8','spades')),false,'Spade only beaten by spade');

  // Unnoticed off-turn trick survives the 15-second accusation deadline.
  const expiry = new PidorGame([{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}]);
  expiry.start();
  assert.equal(expiry.takeFromDeck('bob'),true);
  now += VIOLATION_WINDOW_MS;
  assert.equal(expiry.accuse('alice','bob')?.correct,false);
  assert.equal(expiry.state.players[1].penalties,0);
  assert.equal(expiry.state.players[0].penalties,1);

  console.log('PASS: turn identity, off-turn forced self, manual accusation, spade-six forced self, last-spade no-trump, 6-beats-A, 15-second cheat window');
} finally {
  Date.now = originalNow;
}
