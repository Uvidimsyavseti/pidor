import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PidorGame } from './gameLogic.ts';
import { createDrawReveal } from './drawReveal.ts';
import { visibleState } from './visibility.ts';
import {
  clearCurrentAfter, PENALTY_NOTICE_MS, ACCUSATION_VERDICT_MS,
  PENALTY_SPLASH_MS, CARD_REVEAL_MS
} from '../client/src/stores/notificationTiming.ts';

function timerHarness() {
  let now = 0;
  const scheduled = [];
  const schedule = (run, ms) => { scheduled.push({ at: now + ms, run }); };
  const advance = ms => {
    const until = now + ms;
    while (true) {
      scheduled.sort((a,b) => a.at - b.at);
      if (!scheduled.length || scheduled[0].at > until) break;
      const next = scheduled.shift();
      now = next.at;
      next.run();
    }
    now = until;
  };
  return { schedule, advance };
}

// Correct accusation, false accusation, and notification propagation.
{
  const game = new PidorGame([
    { id:'a',name:'А' }, { id:'b',name:'Б' }, { id:'c',name:'В' }
  ]);
  game.start();
  const callbacks = [];
  game.onPenalty = (playerId, reason) => callbacks.push({playerId,reason});
  game.addPenalty(0,'Не положил подходящую карту');
  assert.equal(game.state.players[0].penalties,0, 'No automatic похуёвая');
  assert.deepEqual(callbacks, [], 'No early award notification');
  const right = game.accuse('b','a');
  assert.equal(right?.correct,true);
  assert.equal(right.penalizedId,'a');
  assert.equal(game.state.players[0].penalties,1);
  assert.deepEqual(callbacks.map(x=>x.playerId),['a'],'Confirmed call emits one award');
  const wrong = game.accuse('c','b');
  assert.equal(wrong?.correct,false);
  assert.equal(wrong?.penalizedId,'c');
  assert.equal(game.state.players[2].penalties,1);
  assert.deepEqual(callbacks.map(x=>x.playerId),['a','c'],'False accuser penalized and notified');
  assert.equal(game.state.players[1].penalties,0);
}

{
  const t=timerHarness();
  let sequence=1;
  const original={playerId:'a',reason:'Ошибка'};
  // Proxy simulates Vue/Pinia reactivity: object reference comparison would fail.
  let penalty=new Proxy(original,{});
  assert.notEqual(penalty,original,'Reactive proxy changes object identity');
  clearCurrentAfter(sequence,()=>sequence,()=>{penalty=null;},PENALTY_NOTICE_MS,t.schedule);
  t.advance(PENALTY_NOTICE_MS-1);
  assert.ok(penalty,'Warning remains until its expected duration');
  t.advance(1);
  assert.equal(penalty,null,'Reactive warning disappears after 2050ms using numeric generation');
}
{
  const t=timerHarness();
  let sequence=1;
  let verdict={correct:true,reason:'Пойман'};
  clearCurrentAfter(sequence,()=>sequence,()=>{verdict=null;},ACCUSATION_VERDICT_MS,t.schedule);
  t.advance(1000);
  sequence++;
  verdict={correct:false,reason:'Ложный вызов'};
  const newer=verdict;
  clearCurrentAfter(sequence,()=>sequence,()=>{verdict=null;},ACCUSATION_VERDICT_MS,t.schedule);
  t.advance(1050);
  assert.equal(verdict,newer,'Older warning timer cannot delete the newer verdict');
  t.advance(1000);
  assert.equal(verdict,null,'Newer verdict disappears after 2050ms');
}
{
  const t=timerHarness();
  let sequence=1, splash=true;
  clearCurrentAfter(sequence,()=>sequence,()=>{splash=false;},PENALTY_SPLASH_MS,t.schedule);
  t.advance(800);
  sequence=2;
  clearCurrentAfter(sequence,()=>sequence,()=>{splash=false;},PENALTY_SPLASH_MS,t.schedule);
  t.advance(750);
  assert.equal(splash,true,'Newer penalty splash survives stale timer');
  t.advance(800);
  assert.equal(splash,false,'Penalty splash disappears at 1550ms');
}
{
  const t=timerHarness();
  let sequence=1, reveal={id:'first'};
  clearCurrentAfter(sequence,()=>sequence,()=>{reveal=null;},CARD_REVEAL_MS,t.schedule);
  t.advance(400);
  sequence++;
  reveal={id:'second'};
  const newer=reveal;
  clearCurrentAfter(sequence,()=>sequence,()=>{reveal=null;},CARD_REVEAL_MS,t.schedule);
  t.advance(CARD_REVEAL_MS-400);
  assert.equal(reveal,newer,'Next card cannot be dismissed by earlier draw');
  t.advance(400);
  assert.equal(reveal,null,'Card flip overlay disappears at 1700ms');
}

// Drawn card is face-up for the drawer AND every other player.
// Deck and lower faces must remain masked.
{
  const game=new PidorGame([{id:'a',name:'А'},{id:'b',name:'Б'},{id:'c',name:'В'}]);
  game.start();
  const deck=game.state.deck;
  const nonSpecial=deck.findIndex(card=>card.id!=='6_of_spades');
  assert.ok(nonSpecial>=0);
  [deck[nonSpecial],deck[deck.length-1]]=[deck[deck.length-1],deck[nonSpecial]];
  const before=deck.length;
  const faceUp=deck[before-1];
  assert.equal(game.takeFromDeck('a'),true);
  assert.equal(game.state.activeCard?.card.id,faceUp.id);
  const event=createDrawReveal('a',faceUp,before,game.state.deck.length,'b');
  assert.ok(event,'Actual draw must produce public reveal');
  assert.deepEqual(event.card,faceUp,'Exact original rank/suit publicly revealed');
  assert.equal(event.playerId,'a');
  assert.equal(event.targetPlayerId,'b');
  for(const viewer of ['a','b','c']) {
    const view=visibleState(game.state,viewer);
    assert.equal(view.activeCard?.card.id,faceUp.id,`Viewer ${viewer} sees face-up card`);
    assert.equal(view.activeCard?.card.rank,faceUp.rank);
    assert.equal(view.activeCard?.card.suit,faceUp.suit);
    assert.ok(view.deck.every(card=>card.id.startsWith('masked-')),'Remaining deck is hidden');
    assert.ok(view.players[0].stumps.slice(0,-1).every(card=>card.id.startsWith('masked-')),
      'Lower cards stay concealed');
  }
  assert.equal(createDrawReveal('a',faceUp,before,before,'b'),null,'No draw means no reveal event');
  assert.equal(createDrawReveal('a',undefined,before,before-1),null,'No card means no reveal event');
  assert.equal(game.placeActiveCard('a','b'),true);
  assert.equal(game.state.players[1].stumps.at(-1).id,faceUp.id,'Revealed card reaches the target pile');
}

// UI contract: a real 3D face flip, accessible public reveal, and no blocking warning.
{
  const app=readFileSync(new URL('../client/src/App.vue',import.meta.url),'utf8');
  const store=readFileSync(new URL('../client/src/stores/game.ts',import.meta.url),'utf8');
  const worker=readFileSync(new URL('./cloudflare-worker.ts',import.meta.url),'utf8');
  assert.match(app,/v-if="gameStore\.drawReveal"/,'Flip must render for clients');
  assert.match(app,/:card="gameStore\.drawReveal\.card"/,'Flip shows actual card face');
  assert.match(app,/@keyframes draw-reveal-turn/,'Flip transition exists');
  assert.match(app,/rotateY\(180deg\)/,'Front must become visible during rotation');
  assert.match(app,/\.verdict-toast,\.penalty-toast\s*\{[\s\S]*?pointer-events:none!important/,'Toast cannot block game taps');
  assert.match(store,/message\.type === 'cardDrawReveal'/);
  assert.match(store,/message\.type === 'accusationVerdict'/);
  assert.match(store,/\+\+this\.verdictSequence/,'Vue-safe numeric toast sequence is used');
  assert.match(worker,/broadcastDrawReveal\(event:/);
  assert.match(worker,/createDrawReveal\(move\.actorId/,'Bot draws also revealed');
  assert.match(worker,/createDrawReveal\(id, card, before/,'Human draws also revealed');
}
console.log('PASS: похуёвые only after manual accusation, correct/false calls, toast 1550–2050ms expiry despite Vue proxies, replacement safety, public 3D card flip and visibility for three players');
