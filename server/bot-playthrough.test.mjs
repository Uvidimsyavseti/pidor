import assert from 'node:assert/strict';
import './deal-suit.test.mjs';
import './throw-chain.test.mjs';
import './underlaid-mode.test.mjs';
import './special-draw-rules.test.mjs';
import './accusation-window.test.mjs';
import './penalty-ui-draw.test.mjs';
import './clockwise-trick.test.mjs';
import { PidorGame } from './gameLogic.ts';
import { applyBotMove, nextBotMove } from './botStrategy.ts';

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function checkCards(game) {
  const s=game.state;
  const cards=[...s.deck,...s.discardPile,...s.currentTrick,
    ...(s.activeCard?[s.activeCard.card]:[]),
    ...s.players.flatMap(p=>[...p.hand,...p.stumps])];
  assert.equal(cards.length,36,'All 36 cards remain present');
  assert.equal(new Set(cards.map(c=>c.id)).size,36,'All cards have unique identities');
}

function runSolo(seed,botCount,underlaidCards=true) {
  const random=Math.random;
  Math.random=seeded(seed);
  try {
    const humanId='human';
    const bots=Array.from({length:botCount},(_,i)=>'bot-'+i);
    const game=new PidorGame([
      {id:humanId,name:'Human'},
      ...bots.map((id,i)=>({id,name:'Bot '+(i+1)}))
    ]);
    game.state.mode='bot';
    game.start(underlaidCards);
    checkCards(game);
    const phases=new Set(['DEALING']);
    const moves={human:0,bot:0};
    let steps=0;
    for(;steps<14000 && game.state.phase!=='ENDED';steps++) {
      if (game.state.phase === 'PENALTY_REVIEW') {
        for (const player of game.state.players) game.finishReview(player.id);
        phases.add(game.state.phase);
        continue;
      }
      const botMove=nextBotMove(game,bots);
      const humanMove=nextBotMove(game,[humanId]);
      const move=botMove || humanMove;
      assert.ok(move,'There must be a legal next action');
      if (game.state.phase==='PENALTY_DISTRIBUTION') {
        const expected=game.currentPenaltyTurn();
        assert.ok(expected,'Penalty queue has an active giver');
        assert.equal(move.actorId,expected.giverId,'Penalty must be given in order');
      }
      assert.ok(applyBotMove(game,move),'Every generated bot move must be legal: '+JSON.stringify(move));
      moves[bots.includes(move.actorId)?'bot':'human']++;
      phases.add(game.state.phase);
      checkCards(game);
    }
    assert.equal(game.state.phase,'ENDED','Solo game reaches a conclusion');
    assert.ok(phases.has('MAIN_GAME'),'Main game was reached');
    assert.ok(moves.bot>0 && moves.human>0,'Both bot and human performed actions');
    assert.equal(game.state.players.filter(p=>p.onDuty).length,1,'One player loses');
    console.log('SOLO GAME PASSED '+JSON.stringify({seed,botCount,underlaidCards,steps,phases:[...phases],moves,loser:game.state.players.find(p=>p.onDuty)?.name}));
  } finally { Math.random=random; }
}

runSolo(20261112,1);
runSolo(1234567,2);
runSolo(100820,3);
runSolo(606060,1,false);
runSolo(20260423,5);
console.log('PASS: solo bot strategy works with 1, 2, 3 and 5 bots, both underlaid modes, 36-card integrity and ordered penalties');
