# THREADBOUND

Local Twitch raid arrival experience. Milestone 3 adds broadcaster OAuth, EventSub `channel.raid` detection, and bounded in-memory chat context while keeping the sample workspace available without Twitch credentials.

## Twitch setup

1. Register an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Set its OAuth redirect URL to exactly `http://localhost:4173/auth/twitch/callback`.
3. Copy `.env.example` to `.env` and fill in `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and a private 32-byte `THREADBOUND_ENCRYPTION_KEY`. Keep `.env` private; it is gitignored. The key encrypts OAuth tokens stored in `data/threadbound.sqlite`.
4. Run `npm start`, then open `http://localhost:4173/` and connect the broadcaster account. Approve the requested `user:read:chat` permission to enable bounded chat context.

Use one hostname for the entire sign-in attempt. `APP_BASE_URL` is the canonical browser origin; if the dashboard is opened as `127.0.0.1`, the sign-in route redirects to the canonical `localhost` origin before creating its state cookie. For a different hostname, update `APP_BASE_URL`, `TWITCH_REDIRECT_URI`, and the Twitch app's registered redirect URL to match exactly. Local HTTP intentionally omits the `Secure` cookie attribute; HTTPS deployments add it automatically. `HttpOnly`, `SameSite=Lax`, a ten-minute expiry, and the one-time state match remain enabled in development.

The `channel.raid` EventSub subscription listens for raids arriving at the connected broadcaster. Twitch requires a user access token for WebSocket subscriptions; this subscription type has no additional OAuth scope requirement. The `channel.chat.message` subscription uses the broadcaster-authorized `user:read:chat` scope. Reauthorize an existing connection once to grant that scope. The app collects message text into five-minute pre-raid and three-minute post-raid windows, capped at 160 messages per buffer. Chatter identities are discarded; raw message text is held in memory only and expires with the bounded window. No chat messages are written to SQLite or returned by the status API. AI summaries are not generated yet.

OAuth access and refresh tokens are encrypted at rest in SQLite and never returned to the browser. Keep `THREADBOUND_ENCRYPTION_KEY` private and backed up; losing it makes the stored session unreadable. Restarting the local server restores the broadcaster session and re-establishes EventSub.

To use a different port, update `PORT` in `.env` and register the matching callback URL using `TWITCH_REDIRECT_URI`, for example `http://localhost:4180/auth/twitch/callback`.

## Run and verify

```powershell
npm start
npm test
```

Dashboard: `http://localhost:4173/`  
OBS browser source: `http://localhost:4173/overlay.html`

Live raid details come from Twitch EventSub. The dashboard indicates whether bounded chat collection is authorized and active. Sample conversation content is labeled and excluded from live context. AI summaries are not generated yet; the OBS source remains empty until later milestones provide and the streamer approves live-context content.
