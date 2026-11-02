# THREADBOUND — Devpost draft

## Prepared project fields

**Project name:** THREADBOUND

**Tagline:** Bring newcomers into the conversation, not just the stream.

**Short tagline alternative:** Keep the community connected.

**Project description:**

Every Twitch raid carries viewers into a stream already in progress. New arrivals may miss the conversation that was underway, while the streamer has to welcome them and keep the existing community engaged.

THREADBOUND helps carry that conversation across the raid. It connects a broadcaster through Twitch OAuth and listens for raid and chat events through EventSub. With chat authorization, it keeps a bounded five-minute pre-raid window and captures a separate three-minute post-raid window. It compares the two to prepare a concise newcomer context card: what the community was discussing, what may have been missed, what continued or changed, and one optional way to join in.

With the streamer's explicit AI analysis consent, THREADBOUND sends bounded chat text to the OpenAI Responses API. The request uses structured JSON output, no tools, no conversation state, and `store: false`. Each non-null claim must reference source messages and provide exact source quotes. Server-side validation checks the references, exact quotes, and lexical overlap. That grounding check is heuristic, not a guarantee that a claim is true or semantically supported. If evidence is sparse or ambiguous, the system reports insufficient context instead of inventing a summary.

The dashboard keeps verified Twitch raid facts separate from AI-generated claims. The streamer can edit, approve, or dismiss the draft. Only approved card content is returned to the OBS browser overlay, and a new raid invalidates the previous approval.

Privacy is part of the workflow: AI consent starts OFF; viewer names and IDs are discarded from captured chat context; raw chat is held in memory and is not persisted to SQLite. OpenAI processes submitted content after opt-in. A draft is hidden from OBS until approval, but is visible in the local dashboard. THREADBOUND does not measure silent viewer retention or infer individual viewer behavior.

I used OpenAI Codex throughout development: to plan the architecture and milestones, implement Twitch OAuth/EventSub and the bounded conversation workflow, build the context card and approval boundary, investigate edge cases, and develop the synthetic and browser regression tests. I made the product and privacy decisions and reviewed the resulting changes.

The recorded CLI-enabled automated run passed all 61 tests, including a Playwright Chromium test against an isolated synthetic fixture and a WebSocket integration test against Twitch CLI's official mock EventSub server. That integration test sends a CLI-generated synthetic `channel.raid` through THREADBOUND's production WebSocket client and raid handler, while subscription API and OpenAI calls are mocked. A later run without the CLI available passed 60 tests and skipped that one optional integration test. Neither result establishes real Twitch event delivery, a live Twitch subscription, or a complete live raid-to-OpenAI-to-OBS Studio flow. Overlay rendering was tested in Chromium, not in OBS Studio.

**Technologies:** Node.js 24, JavaScript ES modules, native Node.js HTTP server, HTML, CSS, browser JavaScript, Twitch OAuth, Twitch EventSub WebSocket, OpenAI Responses API, SQLite, AES-256-GCM, Node.js test runner, Playwright, Chromium, OBS Browser Source.

**Repository:** https://github.com/sainithya-2001/threadbound

**Platform / runtime (if requested):** Local Node.js 24 application integrating with Twitch and an OBS Browser Source.

## Officially required submission materials

The official rules specify these items:

1. **Code repository URL:** use the GitHub URL above. The private repository must be shared with `testing@devpost.com`.
2. **Project description:** use the text above; it covers features, functionality, and Codex use.
3. **Codex session ID:** the Codex desktop project listing shows the primary build conversation titled **Plan RAIDBRIDGE architecture**, thread ID `01a1996f-e770-7962-8c69-9d015adc3b5d`, with this repository's project directory. Devpost asks for the session ID shown by `/status`; verify that value in the primary Codex thread before entering it.
4. **Demonstration video URL:** pending. It must be less than three minutes, uploaded to YouTube, publicly viewable (the official final-weekend update says Unlisted is acceptable; Private is not), and show the project functioning on Twitch and how Codex was used.

The Devpost page may display other UI fields. The rules explicitly state the four submission materials above; do not assume an additional field is mandatory unless it is marked required in the signed-in form.

## Codex session ID: verify before submission

The app's supported thread listing provides the primary build thread ID above, but this packet does not assert that it is the `/status` session ID. In the primary **Plan RAIDBRIDGE architecture** Codex thread, type `/status` and press Enter. Copy only the `Session ID` value shown there into Devpost. Do not paste environment, credential, or token output.

## Repository access

Keep the GitHub repository private. On GitHub, open `sainithya-2001/threadbound` → **Settings** → **Collaborators** (or **Collaborators and teams**) → **Add people**. Search for the exact official address `testing@devpost.com`, select it, and grant read access. Check the invitation status and ensure access is active for judging. Do not change repository visibility.

Official sources:

- Rules: https://twitchcon-codex.devpost.com/rules
- Hackathon overview and submission summary: https://twitchcon-codex.devpost.com/
- Final-weekend video / checklist update: https://twitchcon-codex.devpost.com/updates/47341-final-weekend-make-your-project-come-alive
