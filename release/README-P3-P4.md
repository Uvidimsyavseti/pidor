# PIDOR ONLINE — P3/P4 live release

**Production release:** Cloudflare Worker version 98  
**Date:** 2026-11-12  
**New Telegram Mini App:** https://pidor.uvidimsyamd.workers.dev/api/app  
**Bot deep links:** /api/app?mode=bot and /api/app?mode=friends  
**Release metadata:** https://pidor.uvidimsyamd.workers.dev/api/app/meta  
**Original website preserved:** https://pidor.uvidimsyamd.workers.dev/  
**QA preview:** https://pidor-ui-preview.uvidimsyamd.workers.dev/

## Architecture and publication

The production Worker retains the original v94 gameplay engine (Durable Object `PidorRoom` and `LobbyDirectory`), original server WebSocket protocol `/ws`, `/api/rooms`, static assets, and Telegram bot secrets unchanged. Release scripts add only same-origin frontend routes to the compiled Worker and patch Telegram `/start` links to use `/api/app`. Avoid deploying `server/index.ts`: it is a legacy Socket.IO development server and is not the live backend.

The updated, fully bundled release source lives at `release/worker-app-p3-p4.js`. The latest UI source is under `client/src/`. The staging bundle is built by `.github/workflows/p1-p2-preview-bundle.yml` as `preview/worker.mjs`. To ship a newer UI, rebuild it and update the literal `RELEASE_HTML`, `RELEASE_JS`, and `RELEASE_CSS` constants in the release source before uploading. Do not upload `preview/worker.mjs` to production: its `BACKEND` service binding design is staging-only.

The production worker script is uploaded as a multipart request to Cloudflare `PUT /accounts/{account_id}/workers/scripts/pidor/content`, with `main_module: cloudflare-worker.js`. This API preserves existing Worker settings and bindings, including `ASSETS`, `ROOMS`, `LOBBY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`. The new `/api/app` routes are worker-first under the v94 static-asset routing policy. The legacy root homepage remains intact, avoiding replacing or losing any asset files.

**Rollback:** original v94 full compiled Worker source and nine recovered source-map modules are saved in GitHub branch `sync/cloudflare-pidor-v94` (in particular `production-backup/worker-v94.js`); Cloudflare v94 id `6a8e891b-86d0-4b3d-b468-67bfd0e306ac`. Previous v97 id `f6fd03f1-5e5b-42b2-b3cc-48a4857c8a1d`. For any regression, roll Cloudflare back to the last good Worker version and confirm the active deployment points 100% to it, without deleting Durable Objects or mutating secrets. Never roll back by deleting rooms.

## QA completed

- Vue/TypeScript and Vite build PASS; server `tsx --test` gameplay/cheating/card conservation suite PASS via GitHub Actions.
- Two real WebSocket clients both received the same exact drawn card; duplicate `actionId` rejected; moved card appeared in the right pile on both clients, and the shared 36-card deck was conserved.
- Complete 34-draw dealing sequence on a two-player QA game, server phase transitions `DEALING → PENALTY_REVIEW → MAIN_GAME` confirmed, first main game card played and synchronized to both clients.
- Initial dealing in no-underlaid and underlaid modes checked. Up to six seats checked at 320×680 and 430×932 with no horizontal scroll.
- 844×390 landscape uncovered a click-blocking overlap between the dealing self pile and hand footer, then fixed and validated: footer top 336 px, self pile bottom 329 px.
- Legacy routes `/`, `/health`, `/api/rooms`, and original `/cards/BACK_COMMON.webp` preserved, all responding 200 after publication; all original Worker bindings remain present.
- Sound toggle, Telegram viewport/Safe Area, fullscreen request, reduced-motion CSS, end-of-game overlay, room share, and penalty hand transfer UI are implemented.

## Still to check during user testing in Telegram

1. Open the bot, send `/start` to refresh its game buttons and menu to the new Mini App URL, then launch and verify actual Telegram safe areas on iOS and Android.
2. Test card drag/throw and finger tracking in real Telegram iOS, especially swipe-to-collapse prevention.
3. Test entire six-player game and accusation review, including deliberate cheating and sending cards as penalties.
4. Verify the card flip on the correct object and no visual duplicates on two physical phones simultaneously.

This is a published release for hands-on testing, not a guarantee that every in-app interaction has passed device QA.

## Payment

`★ 0 скоро` is only a placeholder. No payment, betting, real Stars balance, or Telegram Stars purchase integration exists.