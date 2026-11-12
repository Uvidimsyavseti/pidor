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
  const game=gameWithTop(c('7','spades'),c('6','hearts'),c('8','clubs'),c('9','diamonds'));
  assert.equal(game.canBeat(c('9','diamonds'),c('6','hearts')),false,'Ranks cannot be skipped');
  assert.equal(game.canBeat(c('9','diamonds'),c('8','clubs')),true,'Next rank works regardless of suit');
  assert.equal(game.placeActiveCard('a','c'),true);
  assert.deepEqual(game.accusableTargets('b'),[],'No foul for correctly skipping wrong rank');
}
{
  const game=gameWithTop(c('7','spades'),c('6','hearts'),c('8','clubs'),c('9','diamonds'));
  assert.equal(game.placeActiveCard('a','b'),true,'Cheating may put a card on an incorrect rank');
  assert.deepEqual(game.accusableTargets('c'),['a'],'False placement is reportable');
  assert.equal(game.accuse('c','a')?.correct,true);
  assert.equal(game.state.players[0].penalties,1);
}
{
  const game=gameWithTop(c('7','spades'),c('8','clubs'),c('8','hearts'),c('9','diamonds'));
  assert.equal(game.placeActiveCard('a','b'),true,'First valid target along the circle');
  assert.deepEqual(game.accusableTargets('c'),[]);
}
{
  const game=gameWithTop(c('7','spades'),c('8','clubs'),c('8','hearts'),c('9','diamonds'));
  assert.equal(game.placeActiveCard('a','c'),true,'Later valid target may be chosen as cheating');
  assert.deepEqual(game.accusableTargets('b'),['a'],'Skipped player may report rule violation');
}
{
  const game=gameWithTop(c('7','spades'),c('6','hearts'),c('8','clubs'),c('9','diamonds'));
  const next=nextBotMove(game,['a']);
  assert.equal(next?.type,'placeActiveCard');
  assert.equal(next?.targetId,'c','Bot must skip wrong rank when choosing destination');
}
{
  const game=new PidorGame(players);
  assert.equal(game.canBeat(c('6','clubs'),c('A','spades')),true,'Non-spade six beats any ace in deal');
  assert.equal(game.canBeat(c('6','spades'),c('A','spades')),false,'Spade six never beats an ace');
  assert.equal(game.canBeat(c('Q','diamonds'),c('J','hearts')),true,'Suit irrelevant during deal');
  assert.equal(game.canBeat(c('Q','diamonds'),c('10','hearts')),false,'Only consecutive rank allowed');
}
console.log('PASS: strict ranks ignoring suits, first eligible clockwise, reportable cheating, bot targeting, six exception');
