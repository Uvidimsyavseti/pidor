# PIDOR — multiplayer web card game

Browser game built with Vue 3, TypeScript, Socket.IO and an Express server.
Playable directly in a browser or through Telegram Mini Apps.

## Local development

Requires Node.js 22+.

Terminal 1:

```sh
cd server
npm ci
npm run dev
```

Terminal 2:

```sh
cd client
npm ci
npm run dev
```

Open http://localhost:5173 and join a room. Two players can test using separate browsers.

## Deployment

### Server (VPS)

Deploy the full repository so `shared/types.ts` remains available.
From `server/`, run `npm ci` then `npm start`.
Use a reverse proxy with TLS for your public WebSocket endpoint, e.g. `https://api.example.com`.

Environment variables:

- `PORT=3001`
- `CLIENT_ORIGINS=https://game.example.com,https://your-project.pages.dev` (comma-separated exact public origins; avoid wildcard in production)
- `TELEGRAM_BOT_TOKEN=...` (secret, server only, configured via @BotFather)

Never put the Telegram bot token in the frontend.

### Cloudflare Pages

Connect this GitHub repository and set:
- Root directory: `client`
- Build command: `npm ci && npm run build`
- Build output directory: `dist`
- `VITE_SERVER_URL=https://api.example.com` (public HTTPS address of the server)
- `VITE_TELEGRAM_BOT_USERNAME=your_bot_username` (optional, for Telegram invitations)

For SPA fallback on Pages, static `index.html` is sufficient for the current single-page app.
The backend **cannot** be deployed as a Cloudflare Pages static site: use a VPS or another persistent Node host.

### Telegram Mini App

1. Create a bot in @BotFather.
2. Configure its Mini App URL to your public HTTPS Pages URL.
3. Set `TELEGRAM_BOT_TOKEN` on the server.
4. Set `VITE_TELEGRAM_BOT_USERNAME` on Pages and redeploy.
5. Open the Mini App from the bot. The client passes Telegram `initData`; the server verifies HMAC-SHA256 and checks freshness (24 hours).
6. Invite friends with the game's invite action.

Browser guest mode remains available without Telegram. Room links use `?room=ROOM_ID`.

## Security and constraints

- The server sends a per-player projection: opponents' hands and the unrevealed deck are masked.
- The server authorizes actions against the joining socket's player identity and room.
- Reconnect tokens are stored in browser sessionStorage. Sessions and games are in server memory, so a **server restart resets games**; persistent storage is not implemented.
- Rooms currently support 2–6 players, without matchmaking.
- This is a development prototype, not a production-audited release. Automated tests, anti-abuse measures, rules auditing, deployment and live multi-device QA are still needed.
