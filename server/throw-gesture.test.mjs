import assert from 'node:assert/strict';
import {
  resolveCardGesture, gestureVelocity, FLICK_SPEED_PX_MS
} from '../client/src/gestures/cardThrow.ts';

const seats=[
  {id:'top',rect:{left:140,top:20,right:260,bottom:105}},
  {id:'left',rect:{left:10,top:145,right:115,bottom:245}},
  {id:'right',rect:{left:285,top:145,right:395,bottom:245}},
  {id:'self',rect:{left:135,top:460,right:265,bottom:550}}
];
const p=(x,y,t)=>({x,y,t});

{
  const points=[p(200,300,0),p(200,250,450),p(198,85,1200)];
  assert.equal(resolveCardGesture(points,seats).targetId,'top',
    'Slow drag released ON player is a placement');
  assert.equal(resolveCardGesture(points,seats).kind,'drop');
}
{
  const points=[p(200,315,0),p(200,260,30),p(200,210,55)];
  const res=resolveCardGesture(points,seats);
  assert.equal(res.targetId,'top','Upward fast swipe hits the top seat');
  assert.equal(res.kind,'flick');
  assert.ok(res.speed>=FLICK_SPEED_PX_MS);
}
{
  const points=[p(200,245,0),p(241,220,24),p(263,205,42)];
  const result=resolveCardGesture(points,seats);
  assert.equal(result.targetId,'right','Rightward throw chooses a seat on its real trajectory');
  assert.equal(result.kind,'flick','Rightward target is hit by projected velocity, not a direct drop');
}
{
  const points=[p(200,300,0),p(170,260,150),p(135,230,350)];
  assert.equal(resolveCardGesture(points,seats).kind,'cancel','Slow drag away from seat does not auto-target');
}
{
  const points=[p(200,315,0),p(200,365,20),p(200,415,40)];
  assert.equal(resolveCardGesture(points,seats).targetId,'self',
    'Fast downward throw to own pile is supported');
}
{
  const points=[p(200,300,0),p(250,350,15),p(280,380,30)];
  assert.equal(resolveCardGesture(points,seats).targetId,null,
    'A quick diagonal miss must not snap to an unrelated seat');
}
{
  const points=[p(200,315,0),p(201,307,22)];
  assert.equal(resolveCardGesture(points,seats).kind,'cancel','Short accidental gestures are not throws');
}
{
  const points=[p(200,315,0),p(200,265,25),p(200,215,50)];
  const res=resolveCardGesture(points,seats,['top']);
  assert.equal(res.targetId,null,'Excluded seat cannot be targeted with a throw');
}
{
  const points=[p(200,300,0),p(200,105,18)];
  const res=resolveCardGesture(points,seats);
  assert.equal(res.kind,'drop','Direct hit wins over fling classification');
}
{
  const seatsOnRay=[
    {id:'near',rect:{left:160,top:185,right:240,bottom:240}},
    {id:'far',rect:{left:140,top:20,right:260,bottom:105}}
  ];
  const res=resolveCardGesture([p(200,310,0),p(200,265,25),p(200,255,35)],seatsOnRay);
  assert.equal(res.targetId,'near','The first seat hit by the ray wins, not the closest seat to start');
}
{
  const vel=gestureVelocity([p(200,340,0),p(200,335,1000),p(200,320,1010),p(200,300,1020)]);
  assert.ok(vel.speed>FLICK_SPEED_PX_MS,'Old motion is ignored; use last 125ms of finger movement');
}
// Guard the physical interaction contract against regressions during redesign.
{
  const {readFileSync}=await import('node:fs');
  const app=readFileSync(new URL('../client/src/App.vue',import.meta.url),'utf8');
  const arena=readFileSync(new URL('../client/src/game-arena.css',import.meta.url),'utf8');
  assert.match(app,/setPointerCapture\(event\.pointerId\)/,'iOS touch maintains the gesture until release');
  assert.match(app,/:disabled="!canDraw && dragging\?\.kind !== 'deck'"/,
    'The tapped deck button cannot disable itself mid-drag');
  assert.match(app,/resolveCardGesture\(samples,seats,exclude\)/,
    'Gesture resolver is used on pointer release');
  assert.match(app,/queuePendingDrop\(target,move\.deckBefore\)/,
    'A fast throw before WebSocket acknowledgement is correctly queued');
  assert.match(arena,/@keyframes seat-card-flight/,
    'Thrown card animates from finger to the selected player');
  assert.match(arena,/gesture-card--face-up/,
    'Card reveals its authentic face on the moving object');
}
console.log('PASS: card throw gesture — slow release, fast flick, trajectory, clockwise-independent targeting, misses, self and duplicate prevention');
