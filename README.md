# THREADBOUND

Local Twitch raid arrival experience. THREADBOUND connects broadcaster OAuth, EventSub `channel.raid`, bounded in-memory chat context, and conversation continuity drafts that stay private until the streamer approves them.

## Twitch setup

1. Register an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Set its OAuth redirect URL to exactly `http://localhost:4173/auth/twitch/callback`.
3. Copy `.env.example` to `.env` and fill in `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, a private 32-byte `THREADBOUND_ENCRYPTION_KEY`, and `OPENAI_API_KEY`. Keep `.env` private; it is gitignored. The encryption key protects OAuth tokens stored in `data/threadbound.sqlite`; the OpenAI key is only used on the server.
4. Run `npm start`, then open `http://localhost:4173/` and connect the broadcaster account. Approve the requested `user:read:chat` permission to enable bounded chat context.

Use one hostname for the entire sign-in attempt. `APP_BASE_URL` is the canonical browser origin; if the dashboard is opened as `127.0.0.1`, the sign-in route redirects to the canonical `localhost` origin before creating its state cookie. For a different hostname, update `APP_BASE_URL`, `TWITCH_REDIRECT_URI`, and the Twitch app's registered redirect URL to match exactly. Local HTTP intentionally omits the `Secure` cookie attribute; HTTPS deployments add it automatically. `HttpOnly`, `SameSite=Lax`, a ten-minute expiry, and the one-time state match remain enabled in development.

The `channel.raid` EventSub subscription listens for raids arriving at the connected broadcaster. Twitch requires a user access token for WebSocket subscriptions; this subscription type has no additional OAuth scope requirement. The `channel.chat.message` subscription uses the broadcaster-authorized `user:read:chat` scope. Reauthorize an existing connection once to grant that scope. The app collects message text into five-minute pre-raid and three-minute post-raid windows, capped at 160 messages and 500 characters per message. Chatter identities are discarded; raw message text is held in memory only and is never written to SQLite or returned by public endpoints.

AI analysis consent is off by default and is held in server memory. The dashboard explains that bounded chat message text is sent to OpenAI when consent is enabled; chatter names, IDs, badges, and other identity fields are discarded, and THREADBOUND does not persist raw chat. Twitch chat capture and raid detection remain independent of this setting. Turning consent off blocks future requests and aborts a pending request where possible; content already transmitted cannot be recalled. A raid missed while consent is off is not submitted retroactively.

After a real raid, THREADBOUND checks at 15 seconds and generates then only if at least eight unique post-raid messages arrived. Otherwise, it generates once at 45 seconds. At least three messages in each window are required; sparse or ambiguous context stays an honest insufficient-context state. The conversation engine sends separate pre-raid and post-raid windows to the OpenAI Responses API with strict structured JSON output, `store: false`, no tools, and a 12-second timeout only after opt-in. `OPENAI_MODEL` is configurable and defaults to `gpt-6-luna`. Evidence references and exact quotes are validated server-side; one invalid reference rejects the whole draft. Evidence quotes and viewer identities are never returned to the dashboard or OBS. Generation runs asynchronously so Twitch event handling and dashboard polling remain responsive.

Live AI cards appear as private dashboard drafts. The streamer can edit, approve, or dismiss them. The OBS browser source uses a server-side approved-card endpoint and remains blank unless the current live card has been approved. Verified Twitch raid facts appear in a separate visual section from AI-generated chat claims. No verified live stream title or game metadata is currently available through this app, so THREADBOUND does not invent it. The local sample workspace remains available when Twitch is disconnected.

OAuth access and refresh tokens are encrypted at rest in SQLite and never returned to the browser. Keep `THREADBOUND_ENCRYPTION_KEY` private and backed up; losing it makes the stored session unreadable. Restarting the local server restores the broadcaster session and re-establishes EventSub.

For an isolated preview, start a separate process with `DEMO_MODE=true` and a preview port such as `4175`. Explicit demo mode takes precedence over credentials loaded from `.env`: the server does not initialize OAuth or the token database, open EventSub, collect chat, or call OpenAI. The consent endpoint rejects attempts to enable AI. The status endpoint reports `demoMode: true` and exposes any sample content under a separately labeled `sampleData` field. Invalid `DEMO_MODE` values fail startup instead of selecting a mode silently.

To use a different port, update `PORT` in `.env` and register the matching callback URL using `TWITCH_REDIRECT_URI`, for example `http://localhost:4180/auth/twitch/callback`.

## Run and verify

```powershell
npm start
npm test
```

Dashboard: `http://localhost:4173/`  
OBS browser source: `http://localhost:4173/overlay.html`

Live raid details come from Twitch EventSub. The dashboard indicates whether bounded chat collection is authorized and active. Sample conversation content is labeled and excluded from live context. API failures, missing chat permission, and insufficient conversation context have separate dashboard states.
