import assert from 'node:assert/strict';
import { PidorGame } from './gameLogic.ts';
import { nextBotMove } from './botStrategy.ts';

function cardsCount(game) {
  const state=game.state;
  const cards=[...state.deck,...state.discardPile,...state.currentTrick,
    ...(state.activeCard ? [state.activeCard.card] : []),
    ...state.players.flatMap(p=>[...p.stumps,...p.hand])];
  assert.equal(cards.length,36,'All 36 cards must remain');
  assert.equal(new Set(cards.map(c=>c.id)).size,36,'Card IDs are unique');
}
const players=[{id:'p1',name:'P1'},{id:'p2',name:'P2'}];

{
  const game=new PidorGame(players);
  game.start(true);
  assert.equal(game.state.underlaidCards,true);
  assert.ok(game.state.players.every(p=>p.stumps.length===3));
  const actor=game.state.players[0];
  const initial=actor.stumps.map(c=>c.id);
  assert.equal(game.canMoveTopCard('p1'),false,'All three original cards are protected');
  assert.equal(game.takeFromPile('p1',initial[2]),false,'Cannot detach the face-up original card');
  assert.equal(game.moveTopTo('p1','p2'),false,'Cannot move an original card, even as cheating');
  assert.deepEqual(actor.stumps.map(c=>c.id),initial,'Failed transfer does not change piles');
  assert.equal(nextBotMove(game,['p1'])?.type,'drawCardFromDeck','Bot never transfers original cards');
  cardsCount(game);
  const top=actor.stumps.at(-1);
  const drawn = game.takeFromDeck('p1');
  assert.equal(drawn,true);
  if (actor.stumps.length>3) {
    const added=actor.stumps.at(-1);
    assert.notEqual(added.id,top.id);
    assert.equal(game.canMoveTopCard('p1'), !['6_of_spades'].includes(added.id) && game.state.deck.length>0);
  }
  cardsCount(game);
}
{
  const game=new PidorGame(players);
  game.start(false);
  assert.equal(game.state.underlaidCards,false);
  assert.equal(game.state.deck.length,34,'One initial open card is dealt to each player');
  assert.ok(game.state.players.every(p=>p.stumps.length===1));
  assert.equal(game.canMoveTopCard('p1'),false,'The lone open starter cannot be moved');
  assert.equal(game.drawTo('p1','p1'),true);
  assert.equal(game.state.players[0].stumps.length,2);
  assert.equal(game.drawTo('p2','p2'),true);
  assert.equal(game.state.players[1].stumps.length,2);
  cardsCount(game);
  for(let guard=0;guard<200&&game.state.phase==='DEALING';guard++){
    const actor=game.state.players[game.state.turnIndex];
    assert.equal(game.drawTo(actor.id,actor.id),true,'Legal self-placing continues without underlaid cards');
    cardsCount(game);
  }
  assert.equal(game.state.phase,'PENALTY_REVIEW','Deal completes in no-underlaid mode');
  for(const p of game.state.players) game.finishReview(p.id);
  assert.equal(game.state.phase,'MAIN_GAME','No-underlaid mode reaches main game');
  assert.ok(game.state.players.every(p=>p.stumps.length===0),'No hidden underlaid cards remain');
  assert.ok(game.state.players.some(p=>p.hand.length>0),'Dealt cards become playable hand cards');
  cardsCount(game);
}
console.log('PASS: original three cards cannot be moved, bot ignores base, no-underlaid mode starts and completes 36-card deal');
