import assert from 'node:assert/strict';
import { PidorGame } from './gameLogic.ts';
import { nextBotMove } from './botStrategy.ts';

const players=[{id:'a',name:'А'}, {id:'b',name:'Б'}, {id:'c',name:'В'}];
const c=(rank,suit,id=rank+'_'+suit)=>({rank,suit,id});
function gameWithTop(topA,topB,topC,card) {
  const game = new PidorGame(players);
  game.start();
  game.state.players[0].stumps[2] = topA;
  game.state.players[1].stumps[2] = topB;
  game.state.players[2].stumps[2] = topC;
  game.state.turnIndex=0;
  game.state.activeCard={card,ownerId:'a',fromDeck:true};
  return game;
}
{
  const game=gameWithTop(c('7','spades'),c('6','hearts'),c('8','clubs'),c('Q','clubs'));
  assert.equal(game.canBeat(c('Q','clubs'),c('6','hearts')),false,'Wrong suit never eligible');
  assert.equal(game.canBeat(c('Q','clubs'),c('8','clubs')),true,'Matching weaker suit is eligible');
  assert.equal(game.placeActiveCard('a','c'),true,'Allowed to skip earlier player with wrong suit');
  assert.deepEqual(game.accusableTargets('b'),[],'No foul for skipping incompatible suit');
  assert.equal(game.state.players[2].stumps.at(-1)?.rank,'Q');
}
{
  const game=gameWithTop(c('7','spades'),c('6','hearts'),c('8','clubs'),c('Q','clubs'));
  assert.equal(game.placeActiveCard('a','b'),false,'Cannot place on incompatible suit even if lower rank');
  assert.equal(game.state.activeCard?.card.rank,'Q','Rejected move does not consume card');
}
{
  const game=gameWithTop(c('7','spades'),c('8','clubs'),c('6','clubs'),c('Q','clubs'));
  assert.equal(game.placeActiveCard('a','b'),true,'First eligible matching suit is allowed');
  assert.deepEqual(game.accusableTargets('b'),[],'Correct earliest suitable target is not penalized');
}
{
  const game=gameWithTop(c('7','spades'),c('8','clubs'),c('6','clubs'),c('Q','clubs'));
  assert.equal(game.placeActiveCard('a','c'),true,'Later matching target can be placed as a foul');
  assert.deepEqual(game.accusableTargets('b'),['a'],'Passing the first eligible same-suit player is a real foul');
  assert.equal(game.accuse('b','a')?.correct,true,'Manual accusation confirms violation');
  assert.equal(game.state.players[0].penalties,1);
}
{
  const game=gameWithTop(c('7','spades'),c('6','hearts'),c('8','clubs'),c('Q','clubs'));
  const next=nextBotMove(game,['a']);
  assert.equal(next?.type,'placeActiveCard');
  assert.equal(next?.targetId,'c','Bot should skip wrong-suit neighbour');
}
{
  const game=new PidorGame(players);
  assert.equal(game.canBeat(c('6','clubs'),c('A','clubs')),true,'Six beats same-suit ace');
  assert.equal(game.canBeat(c('6','clubs'),c('A','hearts')),false,'Six cannot beat ace of another suit');
}
console.log('PASS: first compatible suit clockwise, wrong suit skipped, bot chooses compatible card, manual foul only when truly wrong');
