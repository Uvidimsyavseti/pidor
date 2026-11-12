import assert from 'node:assert/strict';
import { PidorGame } from './gameLogic.ts';

const card = (rank, suit) => rank + '_of_' + suit;
function assertUnique36(game) {
  const s=game.state;
  const cards=[...s.deck,...s.currentTrick,...s.discardPile,
    ...(s.activeCard?[s.activeCard.card]:[]),
    ...s.players.flatMap(p=>[...p.stumps,...p.hand])];
  assert.equal(cards.length,36,'Every card still exists');
  assert.equal(new Set(cards.map(c=>c.id)).size,36,'No duplicates');
}
function setup() {
  const game=new PidorGame([{id:'you',name:'You'},{id:'other',name:'Other'}]);
  game.start();
  const all=[...game.state.deck,...game.state.players.flatMap(p=>[...p.stumps,...p.hand])];
  const byId=new Map(all.map(c=>[c.id,c]));
  function take(id) { const c=byId.get(id); assert.ok(c,id);byId.delete(id);return c; }
  game.state.players[0].stumps=[
    take(card('6','hearts')),take(card('K','clubs')),
    take(card('Q','hearts')),take(card('J','diamonds'))
  ];
  game.state.players[1].stumps=[take(card('10','spades'))];
  game.state.deck=[...byId.values()];
  game.state.turnIndex=0;
  game.state.activeCard=null;
  assertUnique36(game);
  return game;
}
{
  const game=setup();
  assert.equal(game.canBeat(game.state.players[0].stumps.at(-1),game.state.players[1].stumps.at(-1)),true);
  for (const [played, exposed] of [['J','Q'],['Q','K'],['K','6']]) {
    assert.equal(game.moveTopTo('you','other'),true,played+' may be thrown onto the previous card');
    assert.equal(game.state.players[0].stumps.at(-1).rank,exposed,'Previous card must become visible');
    assert.equal(game.state.turnIndex,0,'Legitimate chained throw must preserve turn');
    assertUnique36(game);
  }
  assert.equal(game.canMoveTopCard('you'),false,'The last anchor card cannot be removed');
  assert.equal(game.state.players[1].stumps.at(-1).rank,'K');
  assert.ok(game.state.deck.length>0);
  assert.equal(game.takeFromDeck('you'),true,'When chain ends, a new card can be taken');
  assertUnique36(game);
}
{
  const game=setup();
  // Ignoring a playable top card is cheating, but not automatically fined.
  assert.equal(game.takeFromDeck('you'),true);
  assert.equal(game.state.players[0].penalties,0);
  assert.ok(game.accusableTargets('other').includes('you'),'Opponent may report a missed mandatory throw');
  assert.equal(game.accuse('other','you')?.correct,true);
  assert.equal(game.state.players[0].penalties,1);
  assertUnique36(game);
}
{
  const game=setup();
  assert.equal(game.canBeat({id:card('6','hearts'),rank:'6',suit:'hearts'}, {id:card('A','spades'),rank:'A',suit:'spades'}),true,
    'During initial deal, suits do not matter for the regular six-on-ace wrap');
  assert.equal(game.canBeat({id:card('6','spades'),rank:'6',suit:'spades'}, {id:card('A','spades'),rank:'A',suit:'spades'}),false,
    'Spade six cannot be thrown onto any ace');
  assert.equal(game.canBeat({id:card('9','clubs'),rank:'9',suit:'clubs'}, {id:card('7','clubs'),rank:'7',suit:'clubs'}),false,
    'Skipped rank is not a valid sequence');
}
console.log('PASS: three-card throwing chain, previous top revealed, mandatory pile throw, 36 cards, six/ace exception');
