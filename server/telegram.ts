interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOOTSTRAP_KEY?: string;
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

export async function handleTelegram(request: Request, env: TelegramEnv): Promise<Response> {
  const url = new URL(request.url);
  const configured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
  if (url.pathname === '/telegram/status' && request.method === 'GET') {
    return Response.json({ ready: configured, message: configured ? 'Bot credentials configured' : 'Waiting for BotFather credentials' });
  }
  if (url.pathname === '/telegram/activate' && request.method === 'POST') {
    if (!configured) return Response.json({ error: 'Configure Cloudflare secrets first' }, { status: 503 });
    if (!secretEquals(request.headers.get('X-Telegram-Setup-Key') || '', env.TELEGRAM_WEBHOOK_SECRET!)) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET!)) {
      return Response.json({ error: 'Webhook secret must be 1-256 chars (letters, numbers, _ or -)' }, { status: 400 });
    }
    return activateBot(env, url.origin);
  }
  // One-time bootstrap guarded by a separate, short-lived Cloudflare secret.
  // The bootstrap key is never a bot token or webhook secret.
  if (url.pathname === '/telegram/bootstrap' && request.method === 'GET') {
    if (!configured || !env.TELEGRAM_BOOTSTRAP_KEY) return new Response('Not found', { status: 404 });
    if (!secretEquals(url.searchParams.get('key') || '', env.TELEGRAM_BOOTSTRAP_KEY)) {
      return new Response('Forbidden', { status: 403 });
    }
    return activateBot(env, url.origin);
  }
  if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
    if (!configured) return new Response('Not configured', { status: 503 });
    const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!secretEquals(received, env.TELEGRAM_WEBHOOK_SECRET!)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (Number(request.headers.get('content-length') || 0) > 64_000) {
      return new Response('Payload too large', { status: 413 });
    }
    try {
      const update = await request.json() as TelegramUpdate;
      await replyToMessage(env, update, url.origin);
      return new Response('OK', { status: 200 });
    } catch (e) {
      console.warn('Telegram update handling error', String(e).slice(0, 240));
      return new Response('Telegram update error', { status: 500 });
    }
  }
  return new Response('Not found', { status: 404 });
}
