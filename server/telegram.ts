interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

type TelegramUpdate = {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id: number; type: string };
    from?: { first_name?: string };
  };
};
type TelegramResult<T = unknown> = { ok: boolean; result?: T; description?: string };

function secretEquals(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    mismatch |= (left[i] || 0) ^ (right[i] || 0);
  }
  return mismatch === 0;
}

async function callTelegram<T = unknown>(
  env: TelegramEnv, method: string, body: Record<string, unknown>
): Promise<TelegramResult<T>> {
  const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await response.json() as TelegramResult<T>;
  if (!response.ok || !json.ok) throw new Error(method + ': ' + (json.description || 'Telegram API failure'));
  return json;
}

function miniAppLink(origin: string, mode?: 'friends' | 'bot'): string {
  return origin + (mode === 'bot' ? '/?mode=bot' : '/?mode=friends');
}

async function replyToMessage(env: TelegramEnv, update: TelegramUpdate, origin: string) {
  const message = update.message;
  if (!message?.chat || message.chat.type !== 'private') return;
  const raw = (message.text || '').trim();
  const command = raw.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (!['/start', '/play', '/game', '/help'].includes(command)) return;

  const greeting = message.from?.first_name
    ? 'Привет, ' + message.from.first_name.slice(0, 32) + '!\n\n'
    : 'Привет!\n\n';
  const text = command === '/help'
    ? 'PIDOR — карточная игра на 36 карт.\n\nИграйте с компьютером или пригласите друзей. Открой игру кнопкой ниже. Внутри есть краткие правила и выбор режима.'
    : greeting + 'Добро пожаловать в PIDOR!\n\nВыбирай: сыграть с ботом или собрать друзей за одним столом.';
  await callTelegram(env, 'sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_markup: { inline_keyboard: [
      [{ text: '🤖 Играть с ботом', web_app: { url: miniAppLink(origin, 'bot') } }],
      [{ text: '🃏 Играть с друзьями', web_app: { url: miniAppLink(origin, 'friends') } }]
    ] }
  });
}

async function activateBot(env: TelegramEnv, origin: string): Promise<Response> {
    try {
      const bot = await callTelegram<{ username?: string }>(env, 'getMe', {});
      const webhook = await callTelegram(env, 'setWebhook', {
        url: origin + '/telegram/webhook',
        secret_token: env.TELEGRAM_WEBHOOK_SECRET!,
        allowed_updates: ['message'],
        drop_pending_updates: false
      });
      const menu = await callTelegram(env, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: '🎮 Играть', web_app: { url: origin } }
      });
      await callTelegram(env, 'setMyCommands', {
        commands: [
          { command: 'start', description: 'Открыть PIDOR' },
          { command: 'play', description: 'Выбрать игру с ботом или друзьями' },
          { command: 'help', description: 'Как играть' }
        ]
      });
      return Response.json({ ok: true, username: bot.result?.username, webhook: webhook.ok, menu: menu.ok });
    } catch (e) {
      console.error('Telegram activation error', String(e).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]'));
      return Response.json({ error: 'Telegram configuration failed. Check BotFather token and logs.' }, { status: 502 });
    }
 }

export async function handl --- TRUNCATED --- 5,729 chars