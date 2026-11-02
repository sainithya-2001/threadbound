# THREADBOUND
### Keep the community connected.

**THREADBOUND helps Twitch communities preserve conversation context when new viewers arrive through raids.**

A raid can bring an entirely new audience into a stream, but newcomers often arrive in the middle of a conversation. They may not know what the community is discussing, what just happened, or how to participate.

THREADBOUND bridges that context gap.

It captures a bounded window of conversation before and after a raid, identifies what continued or changed, and creates an evidence-grounded context card for the streamer to review. Nothing reaches the public OBS overlay until the streamer approves it.

---

## The problem

Twitch raids bring communities together, but conversation doesn't automatically transfer with them.

New arrivals can miss:
- The topic everyone was discussing.
- The context behind an ongoing conversation.
- A change in direction after the raid.
- An easy way to join the discussion naturally.

Generic welcome messages acknowledge arrivals, but they don't explain what the community is actually talking about.

## The solution

THREADBOUND turns raid arrival into a conversation-continuity experience.

**Capture → Understand → Review → Approve → Display**

1. **Capture:** Maintain a bounded, temporary chat context before and after a real Twitch raid.
2. **Understand:** Analyze the two conversation windows separately and identify continuity, changes, and missed context.
3. **Review:** Generate a structured context card with evidence-grounded claims.
4. **Approve:** Let the streamer edit, approve, or dismiss the proposed card.
5. **Display:** Publish only the approved card to the OBS browser source.

If the conversation doesn't contain enough evidence, THREADBOUND reports insufficient context rather than inventing an explanation.

---

## What makes THREADBOUND different?

THREADBOUND isn't another generic welcome bot or stream analytics dashboard.

Its central purpose is **conversation continuity across community arrivals**.

- Context comes from actual bounded conversation windows.
- Pre-raid and post-raid discussion are analyzed separately.
- Claims must pass server-side evidence-reference and exact-quote validation.
- The streamer retains editorial control.
- OBS receives approved content only.
- Insufficient context is treated as a valid outcome.

## Features

- Twitch broadcaster OAuth.
- Twitch EventSub raid detection.
- Twitch chat message subscription.
- Five-minute pre-raid and three-minute post-raid context windows.
- Bounded in-memory message capture.
- Conversation continuity analysis through the OpenAI Responses API.
- Structured, evidence-validated context drafts.
- Streamer editing, approval, and dismissal.
- Separate dashboard and OBS browser source.
- Isolated sample-data demo mode.
- Encrypted OAuth token storage.

## Privacy and safety

Privacy is a core design requirement.

- AI analysis consent is OFF by default.
- Bounded chat text is sent to OpenAI only after explicit consent.
- Chatter names, IDs, badges, and other identity fields are discarded from captured context.
- Raw chat is held in memory only and is not persisted to SQLite.
- AI requests use `store: false`, without tools or conversation state.
- Turning consent off blocks future requests and aborts pending requests where possible.
- Content already transmitted cannot be recalled.
- AI-generated drafts remain private until streamer approval.
- OBS never receives an unapproved draft.
- Chat content is treated as untrusted input.

THREADBOUND does not claim to measure silent viewer retention or infer individual viewer behavior.

## Technology

- **Runtime:** Node.js
- **Backend:** Native Node.js HTTP server
- **Frontend:** HTML, CSS, and JavaScript
- **Platform integration:** Twitch OAuth and EventSub WebSockets
- **Conversation intelligence:** OpenAI Responses API
- **OAuth token storage:** SQLite, encrypted at rest
- **Token security:** AES-256-GCM encryption
- **Streaming integration:** OBS browser source
- **Testing:** Node.js built-in test runner

## Run locally

Requirements:
- Node.js 24 or compatible modern Node.js runtime.
- A Twitch Developer application for live integration.
- An OpenAI API key for AI analysis.

### 1. Install dependencies

```powershell
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and configure:

```env
PORT=4173
APP_BASE_URL=http://localhost:4173
TWITCH_REDIRECT_URI=http://localhost:4173/auth/twitch/callback

TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret

THREADBOUND_ENCRYPTION_KEY=replace_with_32_byte_base64url_key

OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-6-luna
```

`THREADBOUND_ENCRYPTION_KEY` must decode to exactly 32 bytes. The application accepts base64url or 64 hexadecimal characters. For a new setup, after copying `.env.example` to `.env`, run this in PowerShell to securely generate a base64url key and write it directly into the example placeholder without displaying it:

```powershell
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
```

The key is stored locally in `.env`, which is excluded from Git. Do not run this command for an existing database or replace a key that is already configured: stored OAuth tokens cannot be decrypted with a different key. Keep `.env` private.

Register the exact redirect URL in the Twitch Developer Console:

`http://localhost:4173/auth/twitch/callback`

### 3. Start THREADBOUND

```powershell
npm start
```

Open the dashboard:

`http://localhost:4173/`

Connect the broadcaster account and authorize the requested chat permission.

### 4. Open the OBS browser source

`http://localhost:4173/overlay.html`

The overlay remains blank until the streamer approves a context card.

## Isolated demo mode

THREADBOUND includes an isolated demo mode that uses clearly labelled illustrative sample content.

Start a separate demo instance:

```powershell
$env:PORT = "4175"
$env:DEMO_MODE = "true"
node server.mjs
```

Open:

- Dashboard: `http://localhost:4175/`
- OBS overlay: `http://localhost:4175/overlay.html`

Demo mode overrides credentials loaded from `.env`. It does not initialize Twitch OAuth or token storage, connect EventSub, collect chat, or make OpenAI requests. AI consent cannot be enabled in this mode.

Sample content is illustrative and is never presented as a real Twitch raid.

## Testing

Run the automated test suite:

```powershell
npm test
```

The test suite covers:

- Bounded chat capture and expiration.
- Raid and message deduplication.
- Twitch EventSub session handling.
- OAuth state validation and token refresh.
- Encrypted token persistence.
- Evidence validation and prompt-injection handling.
- AI consent and failure handling.
- Streamer approval and OBS publishing boundaries.
- Demo-mode isolation.

**Latest verified result: 52 passed, 0 failed, 0 skipped.**

## Project status

THREADBOUND is a working prototype with implemented Twitch integration, bounded conversation capture, conversation intelligence, privacy safeguards, and an isolated demo experience.

Twitch OAuth and the `channel.raid` and `channel.chat.message` subscription checks have succeeded in prior integration verification. Full end-to-end validation of a real raid through AI generation and OBS publication remains a testing goal.

## Vision

We believe a raid should be more than an audience transfer.

It should be a moment when communities can connect without losing the conversation that brought them together.

**THREADBOUND — Keep the community connected.**
