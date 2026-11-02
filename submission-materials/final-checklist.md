# THREADBOUND — Final submission checklist

## Verified

- [x] GitHub repository: https://github.com/sainithya-2001/threadbound
- [x] `main` points to `2fa1570ffe44369e836a0118b62776b18ba8af0e`.
- [x] Repository visibility is private.
- [x] Remote README exists and contains no merge-conflict markers.
- [x] Expected source and test files are present in the remote tree.
- [x] Recorded CLI-enabled automated suite: 61 passed, 0 failed, 0 skipped; includes Playwright Chromium against an isolated synthetic fixture and a Twitch CLI mock EventSub WebSocket test of the production client and raid handler. The CLI subscription adapter and OpenAI request are mocked; this is not a live Twitch raid or real OpenAI generation. A later CLI-unavailable run passed 60 and skipped this opt-in test.

## Required by the official Devpost rules

- [ ] Submit the repository URL.
- [ ] Submit the text description explaining features/functionality and Codex use (draft: `devpost-draft.md`).
- [ ] Submit the Codex session ID from `/status` in the primary build thread.
- [ ] Submit a YouTube demo URL under three minutes, publicly viewable, showing the project working on Twitch and how Codex was used.
- [ ] Keep private GitHub access available to `testing@devpost.com` for judging/testing. The repo is currently private; the user must invite this exact address with read access and confirm the invitation is accepted/active.
- [ ] Ensure the repository remains available without restriction for judging/testing through the judging period.
- [ ] Review the signed-in Devpost submission form and complete any fields it marks required. The rules explicitly identify the repository URL, description, Codex session ID, and video; they do not enumerate every UI field.
- [ ] Review the final filled submission with the user and obtain explicit approval before submitting.

## Still needs user action

- [ ] In the primary Codex thread **Plan RAIDBRIDGE architecture**, enter `/status` and copy the `Session ID` field. The supported thread listing exposes thread ID `01a1996f-e770-7962-8c69-9d015adc3b5d`; confirm whether `/status` reports the same value before submission.
- [ ] Coordinate a real Twitch-working recording segment. Do not imply a synthetic raid is live Twitch footage. The full live raid → chat → OpenAI → approval → OBS Studio flow remains unverified.
- [ ] Record the video, approve the final edit, and upload it to YouTube as Public or Unlisted.
- [ ] Invite `testing@devpost.com` to the private repository from GitHub Settings → Collaborators, with read access; verify access is active. Do not make the repo public.
- [ ] Review Devpost's final form and submit before the listed deadline, after approval.

## Honest limitations to retain

- Automated tests use synthetic chat/events and mocked OpenAI responses; they do not prove real chat delivery or real model generation.
- The Chromium browser test is not an OBS Studio test.
- Evidence checks are heuristic, not proof of truth; generated card text can repeat source wording.
- AI consent starts OFF, and only opt-in causes chat text to be sent to OpenAI.

## Official references

- Rules: https://twitchcon-codex.devpost.com/rules
- Hackathon overview: https://twitchcon-codex.devpost.com/
- Official final-weekend checklist: https://twitchcon-codex.devpost.com/updates/47341-final-weekend-make-your-project-come-alive
