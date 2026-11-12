<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import CardComponent from './CardComponent.vue';
import { playSound, soundEnabled, toggleSound } from '../audio/gameAudio';
import type { Card } from '@shared/types';

interface Table {
  id: string; title: string; seats: number; capacity: number;
  players: string[]; phase: string; visibility: 'public' | 'private'; underlaidCards?: boolean;
}
const props = defineProps<{
  initialName?: string; initialRoom?: string; initialMode?: 'friends' | 'bot';
  connecting?: boolean; serverError?: string;
}>();
const emit = defineEmits<{
  start: [payload: { name: string; room: string; mode: 'friends' | 'bot'; botCount: number; underlaidCards: boolean }];
}>();

const mode = ref<'friends' | 'bot'>(props.initialMode || 'friends');
const tab = ref<'tables' | 'create' | 'code'>(props.initialRoom ? 'code' : 'tables');
const name = ref(props.initialName || '');
const botCount = ref(1);
const newTitle = ref('Стол у камина');
const privateTable = ref(false);
const underlaidCards = ref(true);
const inviteCode = ref(props.initialRoom || '');
const tables = ref<Table[]>([]);
const busy = ref(false);
const loading = ref(true);
const error = ref('');
let poll: ReturnType<typeof setInterval> | null = null;
const validName = computed(() => name.value.trim().length > 0 && name.value.trim().length <= 32);
const onlineCount = computed(() => tables.value.reduce((sum, table) => sum + table.seats, 0));
const artCards: Card[] = [
  { id:'A_of_spades', suit:'spades', rank:'A' },
  { id:'K_of_hearts', suit:'hearts', rank:'K' },
  { id:'Q_of_clubs', suit:'clubs', rank:'Q' }
];
watch(() => props.initialName, value => { if (value && !name.value.trim()) name.value = value; });
watch(() => props.initialRoom, value => {
  if (value) { inviteCode.value = value; tab.value = 'code'; mode.value = 'friends'; }
});

onMounted(() => {
  try { if (!name.value.trim()) name.value = localStorage.getItem('pidor:last-name') || ''; } catch { /* optional */ }
  void refresh();
  poll = setInterval(() => { if (mode.value === 'friends') void refresh(true); }, 9000);
});
onUnmounted(() => { if (poll) clearInterval(poll); });

async function refresh(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const response = await fetch('/api/rooms', { cache: 'no-store' });
    if (!response.ok) throw new Error('Список столов временно недоступен');
    const result = await response.json() as { tables?: Table[] };
    tables.value = (result.tables || []).filter(t => t.seats > 0 && t.seats < t.capacity);
    if (error.value === 'Не удалось загрузить столы') error.value = '';
  } catch {
    if (!silent) error.value = 'Не удалось загрузить столы';
  } finally { loading.value = false; }
}
function checkName(): boolean {
  if (!validName.value) { error.value = 'Укажи имя (до 32 символов)'; return false; }
  error.value = '';
  return true;
}
function enter(room: string, joinMode: 'friends' | 'bot', useBase = underlaidCards.value): void {
  if (!checkName() || props.connecting) return;
  try { localStorage.setItem('pidor:last-name', name.value.trim()); } catch { /* optional */ }
  playSound('join');
  emit('start', { name: name.value.trim(), room, mode: joinMode, botCount: botCount.value, underlaidCards: useBase });
}
async function createRoom(isPrivate = privateTable.value): Promise<void> {
  if (!checkName() || busy.value || props.connecting) return;
  busy.value = true;
  try {
    const result = await fetch('/api/rooms', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ title: newTitle.value.trim() || 'Стол у камина',
        visibility: isPrivate ? 'private' : 'public', underlaidCards: underlaidCards.value })
    });
    const data = await result.json() as { table?: Table; error?: string };
    if (!result.ok || !data.table) throw new Error(data.error || 'Не удалось создать стол');
    enter(data.table.id, 'friends', data.table.underlaidCards !== false);
  } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка создания стола'; }
  finally { busy.value = false; }
}
async function quickPlay(): Promise<void> {
  if (!checkName() || busy.value) return;
  const room = tables.value.find(t => t.seats > 0 && t.seats < t.capacity);
  if (room) enter(room.id, 'friends', room.underlaidCards !== false);
  else await createRoom(false);
}
function enterCode(): void {
  let value = inviteCode.value.trim();
  if (value.includes('?room=')) {
    try { value = new URL(value).searchParams.get('room') || value; } catch { /* invalid URL fallback */ }
  }
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(value)) {
    error.value = 'Укажи действительный код стола или ссылку-приглашение';
    return;
  }
  enter(value, 'friends');
}
function enterBot(): void {
  const id = 'solo-' + crypto.randomUUID().replace(/-/g,'').slice(0,14);
  enter(id, 'bot');
}
function switchMode(next: 'friends'|'bot') {
  mode.value = next;
  error.value = '';
  playSound('tap');
}
</script>

<template>
  <main class="entry" data-testid="home-lobby">
    <section class="entry__story">
      <h1>PIDOR<br/><em>ONLINE.</em></h1>
      <div class="entry__card-scene" aria-hidden="true">
        <div class="entry__fan">
          <div v-for="(card,i) in artCards" :key="card.id" class="entry__fan-card" :class="'entry__fan-card--' + i"><CardComponent :card="card" /></div>
          <div class="entry__fan-shadow"></div>
        </div>
        
      </div>

    </section>

    <section class="entry__panel">
      <div class="entry__panel-head">
        <div><h2>Выбери стол</h2></div>
        <button type="button" class="entry__audio" :aria-label="soundEnabled ? 'Выключить звук' : 'Включить звук'" @click="toggleSound">{{ soundEnabled ? '♫ Звук вкл.' : '♪ Звук выкл.' }}</button>
      </div>
      <label class="entry__field"><span>ИМЯ ИГРОКА</span>
        <input v-model="name" maxlength="32" autocomplete="nickname" placeholder="Как к тебе обращаться?" data-testid="player-name" />
      </label>

      <div class="entry__mode" role="group" aria-label="Выбери режим игры">
        <button type="button" :class="{ active: mode === 'friends' }" :aria-pressed="mode === 'friends'" @click="switchMode('friends')">
          <b>♣ &nbsp; С друзьями</b><small>Онлайн-столы</small>
        </button>
        <button type="button" :class="{ active: mode === 'bot' }" :aria-pressed="mode === 'bot'" @click="switchMode('bot')">
          <b>♟ &nbsp; С ботом</b><small>Играть одному</small>
        </button>
      </div>

      <template v-if="mode === 'friends'">
        <div class="entry__tabs" role="tablist" aria-label="Способ входа">
          <button type="button" role="tab" :aria-selected="tab === 'tables'" :class="{ active: tab === 'tables' }" @click="tab = 'tables'; playSound('tap')">Свободные</button>
          <button type="button" role="tab" :aria-selected="tab === 'create'" :class="{ active: tab === 'create' }" @click="tab = 'create'; playSound('tap')">Создать стол</button>
          <button type="button" role="tab" :aria-selected="tab === 'code'" :class="{ active: tab === 'code' }" @click="tab = 'code'; playSound('tap')">По коду</button>
        </div>

        <div v-if="tab === 'tables'" class="entry__tables">
          <div class="entry__tables-head">
            <span>ОЖИДАЮТ <b>{{ tables.length }}</b> СТОЛОВ · {{ onlineCount }} ИГРОКОВ</span>
            <button type="button" :disabled="loading" @click="refresh()">↻ Обновить</button>
          </div>
          <div v-if="loading && !tables.length" class="entry__no-tables">Ищем свободные столы…</div>
          <div v-else-if="!tables.length" class="entry__no-tables">
            <div class="entry__no-tables-icon">♧</div>
            <strong>Пока тихо у камина</strong>
            <span>Создай стол и пригласи друзей.</span>
          </div>
          <div v-else class="entry__table-list">
            <button v-for="table in tables" :key="table.id" type="button"
              class="entry__table-item" :disabled="props.connecting" @click="enter(table.id,'friends',table.underlaidCards !== false)">
              <span class="entry__table-icon">♠</span>
              <span class="entry__table-info"><strong>{{ table.title }}</strong><small>{{ table.underlaidCards === false ? 'Без подложенных' : 'С подложенными' }} · {{ table.players.join(', ') || 'Ожидает' }}</small></span>
              <span class="entry__table-seats">{{ table.seats }}/{{ table.capacity }} <span>↗</span></span>
            </button>
          </div>
          <button type="button" class="entry__primary" :disabled="busy || connecting" @click="quickPlay()">
            {{ connecting || busy ? 'Подключаемся…' : tables.length ? 'БЫСТРО СЕСТЬ ЗА СТОЛ' : 'ОТКРЫТЬ ПЕРВЫЙ СТОЛ' }}
            <span>✧</span>
          </button>
          
        </div>

        <form v-else-if="tab === 'create'" class="entry__create" @submit.prevent="createRoom()">
          <div class="entry__base-mode" role="group" aria-label="Подложенные карты">
            <button type="button" :class="{active:underlaidCards}" :aria-pressed="underlaidCards" @click="underlaidCards = true">С подложенными</button>
            <button type="button" :class="{active:!underlaidCards}" :aria-pressed="!underlaidCards" @click="underlaidCards = false">Без подложенных</button>
          </div>
          <label class="entry__field"><span>НАЗВАНИЕ СТОЛА</span><input v-model="newTitle" maxlength="36" placeholder="Стол у камина"/></label>
          <button type="button" class="entry__privacy" :aria-pressed="privateTable" @click="privateTable = !privateTable">
            <span class="entry__privacy-icon">{{ privateTable ? '♧' : '♣' }}</span>
            <span><strong>{{ privateTable ? 'Приватный стол' : 'Публичный стол' }}</strong><small>{{ privateTable ? 'Вход только по приглашению' : 'Появится в списке свободных' }}</small></span>
            <span class="entry__switch" :class="{ active: privateTable }"></span>
          </button>
          <button type="submit" class="entry__primary" :disabled="busy || connecting">{{ busy ? 'Открываем…' : 'СОЗДАТЬ СТОЛ' }} <span>✧</span></button>
          
        </form>

        <form v-else class="entry__create" @submit.prevent="enterCode()">
          <label class="entry__field"><span>КОД КОМНАТЫ ИЛИ ССЫЛКА</span><input v-model="inviteCode" autocomplete="off" spellcheck="false" placeholder="t_... или https://.../?room=..." data-testid="room-code"/></label>
          
          <button type="submit" class="entry__primary" :disabled="connecting">ПРИСОЕДИНИТЬСЯ <span>↗</span></button>
          <button type="button" class="entry__secondary" @click="tab = 'tables'; void refresh()">Посмотреть свободные столы</button>
        </form>
      </template>

      <div v-else class="entry__bots">
        <div class="entry__base-mode" role="group" aria-label="Подложенные карты">
          <button type="button" :class="{active:underlaidCards}" :aria-pressed="underlaidCards" @click="underlaidCards = true">С подложенными</button>
          <button type="button" :class="{active:!underlaidCards}" :aria-pressed="!underlaidCards" @click="underlaidCards = false">Без подложенных</button>
        </div>
        <div class="entry__bot-portrait">♠ <span>♜</span> ♣</div>
        <h3>Партия с компьютером</h3>
        
        <label class="entry__field"><span>СОПЕРНИКИ</span>
          <select v-model.number="botCount"><option :value="1">Один бот — дуэль</option><option :value="2">Два бота — втроём</option><option :value="3">Три бота — вчетвером</option><option :value="4">Четыре бота — впятером</option><option :value="5">Пять ботов — вшестером</option></select>
        </label>
        <button class="entry__primary" type="button" :disabled="connecting" @click="enterBot()">{{ connecting ? 'Запускаем…' : 'НАЧАТЬ ИГРУ С БОТОМ' }} <span>✧</span></button>
      </div>
      <div v-if="error || serverError" class="entry__error" role="alert">{{ serverError || error }}</div>
      
    </section>
  </main>
</template>

<style scoped>
.entry { flex:1; display:grid; grid-template-columns:minmax(0,1.08fr) minmax(365px,.92fr); gap:clamp(22px,4.5vw,90px); align-items:center; padding:clamp(25px,4vw,55px) 24px; width:min(1240px,100%); margin:auto; }
.entry__story { min-width:0; position:relative; padding:10px 0 4px; }
.entry__eyebrow,.entry__mini-label { font-size:11px; font-weight:900; letter-spacing:.22em; color:#eac889; }
.entry__live-dot { display:inline-block; width:7px; height:7px; margin-right:8px; border-radius:50%; background:#95d4a5; box-shadow:0 0 0 4px rgba(144,215,154,.13); vertical-align:middle; }
.entry__story h1 { font-family:Georgia,'Times New Roman',serif; font-size:clamp(48px,6vw,92px); letter-spacing:-.06em; line-height:1.06; font-weight:700; margin:20px 0; color:#f7e8c6; text-shadow:0 4px 20px rgba(0,0,0,.2); }
.entry__story h1 em { font-style:normal; color:#edbe73; }
.entry__lead { color:#e4d0ab; line-height:1.7; font-size:clamp(13px,1.3vw,17px); max-width:480px; }
.entry__card-scene { position:relative; height:265px; margin:25px auto 0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.entry__fan { position:relative; width:320px; height:212px; }
.entry__fan-card { position:absolute; top:5px; left:calc(50% - 60px); transform-origin:50% 90%; filter:drop-shadow(0 17px 10px #090d0780); }
.entry__fan-card :deep(.playing-card) { --width:122px !important; border-radius:10px; }
.entry__fan-card--0 { transform:translate(-65px,23px) rotate(-22deg); }
.entry__fan-card--1 { transform:translate(5px,-5px) rotate(5deg); z-index:2; }
.entry__fan-card--2 { transform:translate(78px,25px) rotate(23deg); z-index:1; }
.entry__fan-shadow { position:absolute; bottom:-8px; left:35px; right:35px; height:25px; background:#080e0a88; filter:blur(20px); border-radius:50%; }
.entry__card-caption { margin-top:0; font-size:11px; letter-spacing:.18em; color:#deb576; font-weight:800; }
.entry__facts { display:flex; flex-wrap:wrap; gap:12px 20px; color:#e3cda1; font-size:11px; letter-spacing:.03em; margin-top:18px; }
.entry__panel { min-width:0; padding:clamp(20px,2.9vw,36px); border-radius:28px; border:2px solid #b78c55; background:linear-gradient(140deg,rgba(30,59,41,.97),rgba(14,37,30,.99)); box-shadow:0 0 0 5px #3c2517,0 0 0 7px #9b6235,0 20px 68px #0008,inset 0 0 25px #08150d66; display:flex; flex-direction:column; gap:17px; }
.entry__panel-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.entry__panel h2 { font:700 clamp(23px,2.5vw,33px) Georgia,serif; letter-spacing:-.025em; color:#f4dfb7; margin:6px 0 0; }
.entry__audio { flex:none; border:1px solid #a28558; border-radius:10px; background:#244034; color:#eedab8; min-height:34px; padding:5px 10px; font-size:11px; cursor:pointer; }
.entry__field { display:flex; flex-direction:column; gap:8px; min-width:0; }
.entry__field > span { color:#d7c29b; letter-spacing:.13em; font-weight:900; font-size:10px; }
.entry__field input,.entry__field select { width:100%; min-width:0; min-height:47px; border:1px solid rgba(229,193,127,.48); border-radius:10px; background:#102a22; padding:11px 13px; color:#fff1d0; outline:none; font-size:16px; }
.entry__field input:focus,.entry__field select:focus { border-color:#f9d28b; box-shadow:0 0 0 3px #e8b86630; }
.entry__field input::placeholder { color:#829886; }
.entry__mode { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
.entry__mode button { border:1px solid #587357; border-radius:12px; background:#173329; color:#cddac4; min-height:62px; padding:8px 5px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; cursor:pointer; }
.entry__mode button.active { background:linear-gradient(155deg,#6e4b2a,#4b3727); border-color:#d2a46c; box-shadow:inset 0 0 0 1px #dcb98438; }
.entry__mode b { font-size:13px; color:#f4dbad; }
.entry__mode small { color:#a6bcaa; font-size:10px; }
.entry__mode button.active small { color:#ead0a5; }
.entry__tabs { display:grid; grid-template-columns:1fr 1fr 1fr; gap:3px; background:#10271f; padding:4px; border-radius:10px; }
.entry__tabs button { color:#a6bba7; background:none; border:0; padding:9px 3px; font-size:11px; font-weight:850; border-radius:7px; cursor:pointer; }
.entry__tabs button.active { color:#2d2718; background:#e9c58b; }
.entry__tables,.entry__create,.entry__bots { min-height:250px; display:flex; flex-direction:column; gap:12px; }
.entry__tables-head { display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:10px; letter-spacing:.12em; color:#b6caac; font-weight:900; }
.entry__tables-head b { color:#edc481; }
.entry__tables-head button { color:#f3d49c; border:0; background:none; cursor:pointer; padding:6px; font-size:11px; }
.entry__no-tables { flex:1; min-height:115px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:5px; text-align:center; color:#a1bba8; font-size:12px; }
.entry__no-tables strong { color:#f2dcaf; font-size:14px; }
.entry__no-tables span { max-width:285px; }
.entry__no-tables-icon { font:34px Georgia,serif; color:#c9a367; }
.entry__table-list { flex:1; min-height:115px; max-height:210px; display:flex; flex-direction:column; gap:7px; overflow-y:auto; scrollbar-color:#997b4c transparent; }
.entry__table-item { width:100%; display:flex; align-items:center; gap:11px; text-align:left; padding:9px 11px; background:#173a2d; color:#e7d5b2; border:1px solid #506b4d; border-radius:11px; cursor:pointer; }
.entry__table-item:hover,.entry__table-item:focus-visible { border-color:#e1bc84; background:#244737; }
.entry__table-icon { display:grid; place-items:center; flex:none; width:34px; height:39px; border-radius:7px; background:#64452b; color:#ead29f; border:1px solid #aa8253; font:22px Georgia,serif; }
.entry__table-info { display:flex; flex-direction:column; gap:4px; min-width:0; flex:1; }
.entry__table-info strong { font-size:12px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.entry__table-info small { font-size:10px; color:#adc8b0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.entry__table-seats { color:#e8cd94; font-weight:900; font-size:12px; white-space:nowrap; }
.entry__table-seats span { font-size:17px; margin-left:4px; }
.entry__primary { min-height:48px; width:100%; border:1px solid #f4d08e; border-radius:11px; background:linear-gradient(150deg,#f4d79c,#c99550); box-shadow:inset 0 1px #fff6cb85,0 5px 16px #0004; color:#282518; font-size:12px; font-weight:950; letter-spacing:.06em; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:14px; }
.entry__primary:disabled { opacity:.5; cursor:wait; }
.entry__primary span { font-size:20px; }
.entry__secondary { font-size:11px; color:#e7c18a; border:0; background:none; cursor:pointer; text-align:center; padding:8px; }
.entry__helper { color:#9bb39e; font-size:11px; text-align:center; margin:0; line-height:1.5; }
.entry__privacy { display:flex; gap:12px; align-items:center; text-align:left; border-radius:12px; padding:13px; background:#16372a; border:1px solid #4a6a4c; color:#e8ddba; cursor:pointer; }
.entry__privacy-icon { font:24px Georgia,serif; color:#e9bf80; }
.entry__privacy > span:nth-child(2) { flex:1; display:flex; flex-direction:column; gap:3px; }
.entry__privacy strong { font-size:12px; }
.entry__privacy small { font-size:10px; color:#b5c5ab; }
.entry__switch { display:block; width:35px; height:20px; background:#6c7260; border-radius:40px; padding:3px; }
.entry__switch:before { content:''; display:block; width:14px; height:14px; border-radius:50%; background:#fff1ce; transition:transform .15s; }
.entry__switch.active { background:#cf9d54; }
.entry__switch.active:before { transform:translateX(15px); }
.entry__bots { align-items:stretch; }
.entry__bots h3 { text-align:center; margin:0; font:700 23px Georgia,serif; color:#f4deb6; }
.entry__bots p { color:#aec7af; font-size:12px; text-align:center; line-height:1.5; margin:0 0 5px; }
.entry__bot-portrait { font:30px Georgia,serif; display:flex; align-items:center; justify-content:center; gap:22px; color:#cba972; text-shadow:0 5px 12px #0009; }
.entry__bot-portrait span { font-size:51px; color:#f4daa8; }
.entry__footnote { text-align:center; color:#8cab93; font-size:10px; padding-top:3px; }
.entry__error { padding:10px 12px; border-radius:9px; color:#ffcebe; background:#6e2a22; font-size:12px; text-align:center; }
@media (max-width:950px) {
  .entry { max-width:650px; grid-template-columns:minmax(0,1fr); padding:27px 18px 45px; gap:22px; }
  .entry__story { text-align:center; }
  .entry__story h1 { font-size:clamp(40px,8vw,64px); margin:8px 0 12px; }
  .entry__lead { margin:auto; }
  .entry__card-scene { height:155px; margin:15px 0 0; }
  .entry__fan { height:127px; width:235px; }
  .entry__fan-card :deep(.playing-card) { --width:75px !important; }
  .entry__fan-card { left:calc(50% - 36px); }
  .entry__fan-card--0 { transform:translate(-47px,14px) rotate(-20deg); }
  .entry__fan-card--2 { transform:translate(46px,14px) rotate(20deg); }
  .entry__card-caption { display:none; }
  .entry__facts { justify-content:center; margin-top:8px; }
}
@media (max-width:560px) {
  .entry { padding:15px 9px 33px; gap:15px; }
  .entry__eyebrow { font-size:9px; }
  .entry__story h1 { font-size:clamp(37px,10vw,51px); line-height:1.08; }
  .entry__lead { font-size:12px; line-height:1.55; }
  .entry__card-scene { height:88px; margin:9px 0 0; }
  .entry__fan { height:88px; width:180px; }
  .entry__fan-card :deep(.playing-card) { --width:50px !important; }
  .entry__fan-card { left:calc(50% - 24px); }
  .entry__fan-card--0 { transform:translate(-36px,4px) rotate(-21deg); }
  .entry__fan-card--2 { transform:translate(37px,4px) rotate(21deg); }
  .entry__facts { display:none; }
  .entry__panel { padding:18px 14px; border-radius:19px; gap:14px; box-shadow:0 0 0 3px #392319,0 0 0 4px #ae8150,0 15px 35px #0008; }
  .entry__panel h2 { font-size:24px; }
  .entry__mini-label { font-size:9px; }
  .entry__audio { font-size:10px; padding:5px 7px; }
  .entry__mode button { min-height:54px; }
  .entry__tabs button { font-size:10px; }
  .entry__tables,.entry__create,.entry__bots { min-height:220px; }
}
@media (prefers-reduced-motion:reduce) { .entry__fan-card { transition:none; } }

.entry__fan-card { transition:transform .35s cubic-bezier(.2,.8,.25,1.2),filter .35s; }
@media(hover:hover) and (min-width:951px) {
 .entry__fan:hover .entry__fan-card--0 { transform:translate(-85px,15px) rotate(-28deg); }
 .entry__fan:hover .entry__fan-card--1 { transform:translate(5px,-13px) rotate(0deg); }
 .entry__fan:hover .entry__fan-card--2 { transform:translate(98px,18px) rotate(30deg); }
}
@media(prefers-reduced-motion:reduce) { .entry__fan-card{transition:none;} }

.entry__base-mode{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:4px;background:#10271f;border-radius:10px;min-width:0}
.entry__base-mode button{min-width:0;border:1px solid transparent;background:transparent;border-radius:7px;color:#d7cab0;min-height:39px;padding:7px 5px;cursor:pointer;font-size:11px;font-weight:800}
.entry__base-mode button.active{color:#302315;border-color:#f6d99b;background:linear-gradient(150deg,#efd398,#c99b5a);box-shadow:0 2px 7px #0005}
@media(max-width:365px){.entry__base-mode button{font-size:10px;}}

.entry__story h1 { text-transform:uppercase; font-size:clamp(48px,7vw,106px);line-height:.96;letter-spacing:-.055em;text-shadow:0 5px 0 rgba(13,19,12,.8),0 14px 24px #0b150baa; }
.entry__story h1 em {color:#dfad65;font-style:normal;letter-spacing:.015em;}
.entry__panel {gap:15px}
@media(max-width:950px){ .entry__story h1{font-size:clamp(40px,10vw,72px);margin:12px 0 2px;} .entry__card-scene{height:114px;} }
@media(max-width:560px){ .entry__story h1{font-size:clamp(35px,11vw,54px);margin:5px 0;} .entry__card-scene{height:64px;} .entry__panel{gap:12px} }

/* ━━━━━━━━━━ PIDOR ONLINE — cleaner club lobby ━━━━━━━━━━ */
.entry {
  width:min(1190px,100%);grid-template-columns:minmax(0,1fr) minmax(390px,480px);
  gap:clamp(28px,5vw,100px);
  align-items:center;
  padding:clamp(25px,4vw,68px) 24px;
}
.entry__story {display:flex;flex-direction:column;align-items:flex-start;justify-content:center;}
.entry__story h1 {
  margin:0;
  font-family:Georgia,serif; font-weight:800;
  font-size:clamp(54px,7.8vw,108px);line-height:.97;
  letter-spacing:-.035em;color:#f2e6d2;
  text-shadow:0 12px 28px #0007;
}
.entry__story h1 em {color:#d3ac76;font-style:normal;}
.entry__card-scene {width:100%;height:305px;margin:26px 0 0;justify-content:flex-start;align-items:flex-start;}
.entry__fan{width:min(400px,100%);height:255px;}
.entry__fan-card{left:calc(50% - 75px);filter:drop-shadow(0 12px 10px #020a068a);}
.entry__fan-card :deep(.playing-card){--width:135px!important;}
.entry__fan-card--0{transform:translate(-82px,45px) rotate(-23deg);}
.entry__fan-card--1{transform:translate(7px,5px) rotate(3deg);}
.entry__fan-card--2{transform:translate(99px,50px) rotate(23deg);}
.entry__fan-shadow{bottom:5px;}
.entry__panel {
  gap:16px;padding:clamp(20px,2.7vw,34px);
  background:linear-gradient(155deg,#24352a 0%,#182b21 90%);
  border:1px solid #9c8060;
  border-radius:20px;
  box-shadow:0 20px 55px rgba(0,0,0,.38),inset 0 1px rgba(247,236,203,.06);
}
.entry__panel h2{font:700 31px Georgia,serif;color:#f1e3c9;letter-spacing:-.015em;}
.entry__panel-head{align-items:center;}
.entry__audio{border:1px solid #7e7358;background:#2b4132;border-radius:10px;color:#e9d7b2;}
.entry__field > span{color:#b6b8a9;letter-spacing:.09em;}
.entry__field input,.entry__field select{
  min-height:49px;background:#14271f;border:1px solid #576551;border-radius:11px;
  color:#fbecce;font-size:15px;
}
.entry__field input::placeholder{color:#8ca092;}
.entry__mode button {
  border:1px solid #506751;background:#1c3529;color:#c5d1bf;
  border-radius:11px;min-height:72px;
  transition:transform .17s ease,background .18s ease,border-color .18s ease;
}
.entry__mode button.active{
  border:1px solid #d9b37a;background:#344a34;
  box-shadow:inset 0 0 0 1px rgba(238,200,141,.1);
}
.entry__mode button:hover,.entry__tabs button:hover,.entry__table-item:hover{transform:translateY(-2px);}
.entry__mode button:active,.entry__tabs button:active,.entry__table-item:active{transform:translateY(1px) scale(.99);}
.entry__mode b{font-size:14px;color:#f8e2bd;}
.entry__mode small{font-size:11px;color:#b3c4b1;}
.entry__tabs {background:#15261f;border:1px solid rgba(230,201,157,.14);border-radius:12px;padding:4px;gap:3px;}
.entry__tabs button {color:#b6c6b6;min-height:40px;font-size:11px;border-radius:9px;transition:transform .17s ease,background .18s;}
.entry__tabs button.active {background:#d9b881;color:#242419;}
.entry__tables,.entry__create,.entry__bots{min-height:240px;gap:12px;}
.entry__table-item{background:#1d392c;border:1px solid #4f6b52;color:#f1dfc0;border-radius:10px;min-height:60px;transition:transform .18s ease,background .18s ease,border-color .18s ease;}
.entry__table-item:hover{background:#294b39;border-color:#d0ac76;}
.entry__table-icon{background:#61442b;border-color:#a68253;color:#ebcc9c;}
.entry__table-info strong{font-size:14px;font-weight:800;}
.entry__table-info small{font-size:11px;color:#b3cab7;}
.entry__no-tables {min-height:123px;color:#b8c4b4;gap:7px;}
.entry__no-tables strong{color:#f1ddbe;font-size:15px;}
.entry__no-tables-icon{font-size:29px;color:#c6a26d;}
.entry__primary {
  background:linear-gradient(160deg,#ebcd99,#d4a970);
  color:#23241d;font-size:12px;font-weight:900;
  letter-spacing:.04em;min-height:52px;border:1px solid #f5debb;
  border-radius:11px;box-shadow:0 3px 12px #0005,inset 0 1px #fff7dda3;
  transition:transform .18s ease,filter .18s ease,box-shadow .18s ease;
}
.entry__primary:hover:not(:disabled){transform:translateY(-3px);filter:brightness(1.05);box-shadow:0 8px 20px #0006;}
.entry__primary:active:not(:disabled){transform:translateY(1px) scale(.995);}
.entry__table-seats {color:#ecd3a9;}
.entry__base-mode{background:#14271f;border:1px solid rgba(221,183,118,.18);}
.entry__base-mode button.active{background:#d9b881;border-color:#efd4a6;color:#26251d;}
.entry__privacy{background:#19382a;border-color:#4c6b51;}
.entry__switch.active{background:#a98353;}
.entry__bot-portrait{color:#cdab78;}
.entry__bots h3{color:#f1dfc1;}
@media(max-width:950px){
  .entry{max-width:680px;grid-template-columns:1fr;gap:15px;padding:25px 20px 45px;}
  .entry__story{align-items:center;}
  .entry__story h1{font-size:clamp(45px,10vw,73px);text-align:center;}
  .entry__card-scene{width:240px;height:124px;align-items:center;margin:16px auto 2px;overflow:hidden;}
  .entry__fan{height:150px;width:230px;}
  .entry__fan-card{left:calc(50% - 43px);}
  .entry__fan-card :deep(.playing-card){--width:80px!important;}
  .entry__fan-card--0{transform:translate(-53px,13px) rotate(-22deg);}
  .entry__fan-card--1{transform:translate(2px,0) rotate(3deg);}
  .entry__fan-card--2{transform:translate(56px,15px) rotate(22deg);}
  .entry__panel{width:100%;}
}
@media(max-width:560px){
  .entry{padding:22px 10px 36px;gap:14px;}
  .entry__story h1{font-size:clamp(38px,11vw,58px);line-height:1.02;}
  .entry__card-scene{height:94px;margin:9px 0 0;}
  .entry__fan-card :deep(.playing-card){--width:60px!important;}
  .entry__fan-card{left:calc(50% - 29px);}
  .entry__fan-card--0{transform:translate(-40px,7px) rotate(-23deg);}
  .entry__fan-card--2{transform:translate(42px,8px) rotate(22deg);}
  .entry__panel{padding:19px 14px;border-radius:16px;gap:13px;}
  .entry__panel h2{font-size:25px;}
  .entry__mode button{min-height:60px;}
  .entry__mode b{font-size:12px;}
  .entry__mode small{font-size:10px;}
}
@media(prefers-reduced-motion:reduce){
  .entry__mode button,.entry__tabs button,.entry__table-item,.entry__primary{transition:none!important;}
}

</style>
