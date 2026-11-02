# THREADBOUND

### Keep the community connected.

THREADBOUND helps Twitch streamers preserve the thread of a conversation when a raid brings new viewers into the stream. It captures a short, bounded chat window around a raid and prepares a context card for the streamer to review. The card explains what the conversation is about, what may have been missed, what continued or changed, and one optional way to join in.

THREADBOUND is a streamer review tool, not a retention analytics product. It does not measure silent viewer retention or infer individual viewer behavior.

## The problem and the product

A raid transfers viewers, but not the context of the conversation already underway. Streamers often have to welcome newcomers and explain the discussion while continuing to entertain the audience already there.

THREADBOUND bridges that gap:

**Twitch raid → bounded conversation windows → context draft → streamer review → approved OBS card**

If chat is missing or too sparse, the product reports insufficient context instead of inventing a summary.

## Streamer workflow

1. Connect the broadcaster with Twitch OAuth.
2. Authorize the requested **user:read:chat** permission for chat context.
3. THREADBOUND listens for Twitch **channel.raid** and **channel.chat.message** EventSub events.
4. It maintains a five-minute rolling pre-raid window and captures a separate three-minute post-raid window. It generates once at 15 seconds if eight unique post-raid messages have arrived; otherwise it generates at 45 seconds using available messages.
5. With explicit AI analysis consent, THREADBOUND sends bounded message text to the OpenAI Responses API. Consent starts OFF. Insufficient evidence, missing permission, and API errors are reported as separate states.
6. The streamer edits, approves, or dismisses the draft. Only an approved card is returned by the OBS approval endpoint.

The dashboard keeps verified Twitch raid facts visibly separate from AI-generated claims. Synthetic events and mocked AI output are labelled as test data.

## Architecture

~~~mermaid
flowchart LR
  Twitch[Twitch OAuth + EventSub] --> Raid[Verified raid metadata]
  Twitch --> Chat[Bounded chat messages]
  Chat --> Windows[In-memory pre/post windows]
  Windows --> Consent{Streamer AI consent}
  Consent -->|On| Responses[OpenAI Responses API]
  Responses --> Validate[Structured output + evidence checks]
  Validate --> Draft[In-memory private draft]
  Raid --> Draft
  Draft --> Dashboard[Streamer edit / approve / dismiss]
  Dashboard -->|Approved only| Approved[Approved-card API]
  Approved --> OBS[OBS browser source]
~~~

- **Server:** Node.js 24, native HTTP server, Twitch OAuth, EventSub WebSocket, and SQLite token store.
- **Chat:** ChatContextWindows keeps message text and receive time in memory, caps the rolling windows at 160 messages and each message at 500 characters, and discards chatter identity fields.
- **AI:** OpenAI Responses API with strict JSON Schema output, store=false, no tools, no conversation state, and a bounded request timeout. OPENAI_MODEL is configurable; the current default is gpt-6-luna.
- **Validation:** every non-null generated claim must cite valid message indexes and exact source-message text. A lexical grounding check rejects terms absent from cited text. This is a heuristic, not proof that a claim semantically follows from its evidence; streamer review remains necessary.
- **Approval and OBS:** drafts stay in server memory and are visible in the local dashboard/status response. The OBS overlay reads only the approved-card response. A new raid invalidates a prior approval.
- **Codex:** THREADBOUND was developed iteratively with OpenAI Codex. The built-in and browser tests exercise isolated synthetic fixtures; they do not replace live Twitch verification.

## Privacy and safety

- AI analysis consent is OFF by default and is held in memory. It returns to OFF after a server restart.
- Chat collection is independent of AI consent. Bounded message text is sent to OpenAI only after opt-in and when the evidence minimum is met. OpenAI processes that submitted content. store=false is a request setting; it should not be read as a guarantee about all provider-side retention.
- THREADBOUND discards chatter names, IDs, badges, and other identity fields before retaining chat context. It does not persist raw chat to SQLite. The SQLite store is for encrypted OAuth access/refresh tokens and broadcaster profile metadata.
- Generated card claims can repeat a source sentence verbatim. Evidence references and quotes are not included in dashboard or OBS payloads, but the claim itself may use wording from chat. Inspect the draft before approving it.
- Turning consent off blocks future requests and aborts an in-flight request where possible. Content already transmitted to OpenAI cannot be recalled.
- A draft is private from OBS until approval, but anyone who can reach the local dashboard/status endpoint can see that draft. The server binds to 127.0.0.1 by default and has no separate user sign-in; keep it local.
- The frontend stylesheet imports Google Fonts. In a normal browser session, Google may receive a font request and ordinary browser/network metadata. The automated browser test blocks requests outside its isolated fixture origin.
- THREADBOUND does not measure silent viewer retention or infer individual viewer characteristics.

## Requirements

- Windows or another supported Node.js 24 environment.
- A Twitch Developer application for live integration.
- An OpenAI API key and access to the configured model for live AI generation.
- OBS Studio only if you want to add the browser source to a live scene. The automated overlay test runs in Chromium; it is **not** an OBS Studio test.

## Live app setup

### 1. Install dependencies and browser test browser

~~~powershell
npm install
npx playwright install chromium
~~~

The Playwright package is a development dependency. Installing Chromium is needed for the automated browser test, not for starting the live app.

### 2. Configure Twitch and OpenAI locally

Create your local environment file:

~~~powershell
Copy-Item .env.example .env
~~~

Then set the following values in .env for the default local port:

~~~env
HOST=127.0.0.1
PORT=4173
APP_BASE_URL=http://localhost:4173
TWITCH_REDIRECT_URI=http://localhost:4173/auth/twitch/callback
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
THREADBOUND_ENCRYPTION_KEY=replace_with_32_byte_base64url_key
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-6-luna
~~~

Register this exact redirect URL in the Twitch Developer Console:

**http://localhost:4173/auth/twitch/callback**

Keep the same hostname throughout OAuth: localhost and 127.0.0.1 use separate browser cookies. For a different local port, update PORT, APP_BASE_URL, TWITCH_REDIRECT_URI, and the Twitch Console callback to match. The local APP_BASE_URL port must match PORT.

Keep the Twitch client secret, OpenAI key, and encryption key in the server-side .env. .env is excluded from Git; do not paste secrets into frontend code, commit them, or share them in chat.

THREADBOUND_ENCRYPTION_KEY must decode to exactly 32 bytes. The application accepts base64url or 64 hexadecimal characters. For a **new setup only**, after copying .env.example to .env, run this in PowerShell to generate a key and write it to the placeholder without displaying it:

~~~powershell
$envPath = (Resolve-Path -LiteralPath ".env").Path
$envText = [System.IO.File]::ReadAllText($envPath)
$keyPattern = '(?m)^THREADBOUND_ENCRYPTION_KEY=replace_with_32_byte_base64url_key\r?$'
$keyAssignments = [regex]::Matches($envText, '(?m)^\s*THREADBOUND_ENCRYPTION_KEY\s*=')
if ($keyAssignments.Count -ne 1 -or [regex]::Matches($envText, $keyPattern).Count -ne 1) {
    throw "Refusing to replace an existing or unexpected encryption-key setting. Keep any existing key unchanged."
}

$randomBytes = New-Object byte[] 32
$randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $randomGenerator.GetBytes($randomBytes)
    $key = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $updatedText = [regex]::Replace($envText, $keyPattern, "THREADBOUND_ENCRYPTION_KEY=$key", 1)
    [System.IO.File]::WriteAllText($envPath, $updatedText, [System.Text.UTF8Encoding]::new($false))
}
finally {
    $randomGenerator.Dispose()
    [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    Remove-Variable key, updatedText -ErrorAction SilentlyContinue
}
~~~

Do not run this command for an existing database or replace an existing key: previously stored OAuth tokens cannot be decrypted with a different key.

### 3. Start the live app

~~~powershell
npm start
~~~

- Dashboard: **http://localhost:4173/**
- OBS browser source: **http://localhost:4173/overlay.html**
- Status: **http://localhost:4173/api/twitch/status**

Connect Twitch, authorize chat access, and review the privacy disclosure. AI consent remains OFF until the streamer opts in. Add the overlay URL as an OBS Browser Source. Nothing appears there until a streamer approves a card.

The default bind is local-only. THREADBOUND does not provide separate user authentication; do not expose it on a shared network.

## Demo, synthetic simulation, and automated tests

These are four separate modes:

| Mode | Purpose | Data and integrations |
|---|---|---|
| Live app (npm start, default port 4173) | Connect a broadcaster and use real Twitch services | Uses local .env, encrypted token storage, Twitch OAuth/EventSub/chat, and OpenAI only after consent |
| Demo app (DEMO_MODE=true, example port 4175) | Show illustrative sample content | Ignores Twitch/OpenAI credentials; no OAuth, token DB, EventSub, chat capture, or OpenAI requests; consent is locked OFF |
| Synthetic simulation (node tests/simulation-server.mjs, default port 4176) | Exercise synthetic raid/chat flow with mocked AI | Loopback-only fixture, in-memory data, no .env, SQLite, Twitch, EventSub, or live OpenAI |
| Automated browser test (npm test) | Test rendered dashboard and overlay approval flow | Starts a fresh isolated synthetic fixture on port 4177, uses mocked AI, and blocks browser requests outside that fixture origin |

Example isolated demo start, in a separate PowerShell window:

~~~powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4175"
$env:DEMO_MODE = "true"
node server.mjs
~~~

The demo dashboard and overlay are at http://localhost:4175/ and http://localhost:4175/overlay.html. Sample content is illustrative, never a real Twitch event. The synthetic simulation and automated browser test are test fixtures, not the production app and not evidence of real Twitch message delivery.

## Tests

Run the complete test suite:

~~~powershell
npm test
~~~

Run the browser UI test alone:

~~~powershell
node --test tests/simulation-browser.test.mjs
~~~

The suite covers bounded chat capture, EventSub helpers, OAuth state and token refresh, encrypted token persistence, structured AI evidence validation, consent/error handling, demo isolation, simulation asset allowlisting, and the dashboard-to-OBS approval boundary. Playwright Chromium verifies the six generated dashboard fields, populated edit area, blank overlay before approval, approved-card rendering, dismissal, and payload privacy against synthetic data.

The suite exercises THREADBOUND's production `EventSubWebSocketClient` and raid parser/handler with synthetic notifications. If `THREADBOUND_TWITCH_CLI_EXE` points to the official Twitch CLI, it starts Twitch CLI's mock EventSub WebSocket server and sends a synthetic `channel.raid` through the WebSocket. If the CLI is unavailable, it uses an in-process WebSocket mock that dispatches Welcome, Keepalive, raid, and reconnect frames directly to the same production client; this fallback does not test the WebSocket wire protocol or bind a port. Both paths test destination matching, duplicate rejection, pre-raid freeze, and post-raid capture with an injected subscription API adapter. The fallback always tests the resumed-session path; the CLI path does so when the test can use its preferred port 8080. Conversation generation uses a mocked OpenAI fetch; there are no Twitch API or OpenAI requests and no real Twitch subscription.

On Windows, install the official Twitch CLI using the [Twitch CLI instructions](https://dev.twitch.tv/docs/cli/) (Scoop is the documented package manager):

~~~powershell
scoop bucket add twitch https://github.com/twitchdev/scoop-bucket.git
scoop install twitch-cli
$env:THREADBOUND_TWITCH_CLI_EXE = (Get-Command twitch).Source
npm test
~~~

When the CLI is installed, set its path before `npm test` to select the official mock WebSocket server; otherwise the test automatically uses the in-process fallback. The recorded CLI-enabled full run completed with 61 passed, 0 failed, 0 skipped. The latest fallback run also completed with 61 passed, 0 failed, 0 skipped.

The browser test does not use the current live server or manual simulation state. It does not make real OpenAI calls. It does not test an OBS Studio installation.

**Suite size: 61 tests.** Recorded CLI-enabled result: 61 passed, 0 failed, 0 skipped. Latest in-process fallback result: 61 passed, 0 failed, 0 skipped. Update these results after future test changes.

## Verification limits and project status

Twitch OAuth and EventSub subscription checks were verified in prior live checks. The complete real-world sequence—live raid, real chat delivery, OpenAI generation, streamer approval, and OBS publication—has **not** been verified end to end. OpenAI requests in automated tests are mocked. The overlay has been tested in Chromium, not in OBS Studio.

THREADBOUND is a working prototype. It implements Twitch integration, bounded conversation capture, evidence-checked context drafts, streamer approval, encrypted OAuth token storage, a separate sample demo, and a synthetic browser test. It does not claim to measure retention or know information Twitch does not expose.



**THREADBOUND — Keep the community connected.**
