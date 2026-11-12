import assert from 'node:assert/strict';
import { PidorGame } from './gameLogic.ts';

function makeGame(names) {
  const game = new PidorGame(names.map(id=>({id,name:id})));
  game.start();
  game.state.phase = 'MAIN_GAME';
  game.state.trumpSuit = null;
  game.state.turnIndex = 0;
  game.state.currentTrick = [];
  game.state.trickTargetId = null;
  for (const player of game.state.players) player.hand = [];
  return game;
}
function card(rank,suit='hearts') { return {id:rank+'_of_'+suit,rank,suit}; }

{
  const game = makeGame(['a','b','c']);
  game.state.players[0].hand=[card('7')];
  game.state.players[1].hand=[card('8')];
  game.state.players[2].hand=[card('9')];
  game.playCard('a','7_of_hearts');
  assert.equal(game.state.trickTargetId,'b','Card played by A lands in front of B clockwise');
  assert.equal(game.state.turnIndex,1);
  assert.equal(game.state.currentTrick[0].rank,'7');
  game.playCard('b','8_of_hearts');
  assert.equal(game.state.trickTargetId,'c','Next beating card moves in front of C clockwise');
  assert.equal(game.state.currentTrick.at(-1).rank,'8');
  game.playCard('c','9_of_hearts');
  assert.equal(game.state.currentTrick.length,0,'Completed trick is discarded after every active player');
  assert.equal(game.state.trickTargetId,null,'No empty destination or placeholder remains');
}
{
  const game = makeGame(['a','b','c']);
  game.state.players[0].hand=[card('7')];
  game.state.players[1].hasExited=true;
  game.playCard('a','7_of_hearts');
  assert.equal(game.state.trickTargetId,'c','Skip exited player and attack next seated player');
}
{
  const game = makeGame(['a','b','c']);
  game.state.players[0].hand=[card('7')];
  game.playCard('a','7_of_hearts');
  assert.equal(game.state.trickTargetId,'b');
  game.takeTrick('b');
  assert.equal(game.state.currentTrick.length,0,'Recipient takes top card');
  assert.equal(game.state.trickTargetId,null,'Picking up a trick clears seat targeting');
}
console.log('PASS: main-game play lands in front of next player clockwise, skips exited players, clears on discard/take');
