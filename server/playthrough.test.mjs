import assert from 'node:assert/strict';
import { PidorGame } from './gameLogic.ts';

const values = { '6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13,A:14 };
const score = (c, trump) => values[c.rank] + (c.suit === trump ? 25:0) + (c.suit === 'spades' ? 4:0);
function assertCards(state) {
  const cards = [...state.deck,...state.discardPile,...state.currentTrick,
    ...(state.activeCard?[state.activeCard.card]:[]),
    ...state.players.flatMap(p=>[...p.hand,...p.stumps])];
  assert.equal(cards.length,36,'All 36 cards accounted for');
  assert.equal(new Set(cards.map(c=>c.id)).size,36,'Unique card identities');
}
function chooseOther(game, actor, card) {
  const ps=game.state.players, idx=ps.indexOf(actor);
  for(let i=1;i<ps.length;i++) {
    const p=ps[(idx+i)%ps.length];
    if(game.canBeat(card,p.stumps.at(-1))) return p.id;
  }
  return actor.id;
}
function run(seed, count) {
  let x=seed;
  Math.random=()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296;};
  const game=new PidorGame(Array.from({length:count},(_,i)=>({id:'bot'+i,name:'Bot '+(i+1)})));
  const stats={draw:0,shift:0,place:0,penalties:0,transfer:0,play:0,take:0,stumps:0,exit:0,steps:0};
  game.onPenalty=()=>stats.penalties++;
  game.start();
  assertCards(game.state);
  while(game.state.phase==='DEALING' && stats.steps<5000) {
    stats.steps++;
    const s=game.state, actor=s.players[s.turnIndex];
    if(s.activeCard) {
      const target=s.activeCard.fromDeck&&s.deck.length===0?actor.id:chooseOther(game,actor,s.activeCard.card);
      assert.equal(game.placeActiveCard(actor.id,target),true,'place');
      stats.place++;
    }else{
      const top=actor.stumps.at(-1);
      const canShift=actor.stumps.length>3 && chooseOther(game,actor,top)!==actor.id;
      if(canShift){assert.equal(game.takeFromPile(actor.id,top.id),true,'shift');stats.shift++;}
      else{assert.equal(game.takeFromDeck(actor.id),true,'draw');stats.draw++;}
    }
    assertCards(game.state);
  }
  assert.notEqual(game.state.phase,'DEALING','Dealing finished');
  assert.equal(game.state.deck.length,0,'Deck exhausted');
  assert.equal(game.state.phase,'PENALTY_REVIEW','Every player gets 15 seconds to call out a cheat');
  for(const player of game.state.players) game.finishReview(player.id);
  assert.ok(game.state.trumpSuit===null||['hearts','diamonds','clubs'].includes(game.state.trumpSuit),'Nonspade trump');
  while(game.state.phase==='PENALTY_DISTRIBUTION' && stats.steps<9000) {
    stats.steps++;
    const turn = game.currentPenaltyTurn();
    assert.ok(turn, 'Sequential penalty queue must provide the next transfer');
    const {giverId,receiverId} = turn;
    assert.ok(game.snapshot().penaltyDebts[receiverId]?.[giverId] > 0, 'Penalty turn must have an outstanding debt');
    const giver=game.state.players.find(p=>p.id===giverId);
    assert.ok(giver.hand.length>1,'Retain last hand card');
    const card=[...giver.hand].sort((a,b)=>score(b,game.state.trumpSuit)-score(a,game.state.trumpSuit))[0];
    assert.equal(game.givePenaltyCard(giverId,card.id,receiverId),true,'penalty transfer');
    stats.transfer++;
    assertCards(game.state);
  }
  assert.equal(game.state.phase,'MAIN_GAME','Main game reached');
  for(let steps=0;steps<15000 && game.state.phase!=='ENDED';steps++) {
    stats.steps++;
    const s=game.state;
    for(const p of s.players) {
      if(p.hasExited||p.hand.length||s.currentTrick.length)continue;
      if(p.stumps.length){game.takeStumps(p.id);stats.stumps++;}
      else{game.exitGame(p.id);stats.exit++;}
    }
    if(s.phase==='ENDED')break;
    const actor=s.players[s.turnIndex];
    assert.ok(actor&&!actor.hasExited,'Turn must be active');
    if(!actor.hand.length) {
      if(s.currentTrick.length){game.takeTrick(actor.id);stats.take++;}
      else if(actor.stumps.length){game.takeStumps(actor.id);stats.stumps++;}
      else {game.exitGame(actor.id);stats.exit++;}
    } else {
      const top=s.currentTrick.at(-1)||null;
      const legal=actor.hand.filter(c=>game.isLegalMove(c,top)).sort((a,b)=>score(a,s.trumpSuit)-score(b,s.trumpSuit));
      if(legal.length){game.playCard(actor.id,legal[0].id);stats.play++;}
      else {assert.ok(s.currentTrick.length);game.takeTrick(actor.id);stats.take++;}
    }
    assertCards(game.state);
  }
  assert.equal(game.state.phase,'ENDED','Game must reach a winner/loser state');
  assert.equal(game.state.players.filter(p=>p.onDuty).length,1,'One loser on duty');
  assert.equal(game.state.players.filter(p=>!p.hasExited).length,1,'One remaining player');
  assertCards(game.state);
  return {seed,players:count,loser:game.state.players.find(p=>p.onDuty).name,trump:game.state.trumpSuit,...stats,discarded:game.state.discardPile.length};
}
const oldRandom=Math.random;
try{
  for(const [seed,players] of [[29011,2],[73057,3]]) {
    console.log('FULL MATCH: '+JSON.stringify(run(seed,players)));
  }
  console.log('PASS: TWO complete 36-card matches; phases, penalties, legal play, piles, winner validated.');
}finally{Math.random=oldRandom;}
