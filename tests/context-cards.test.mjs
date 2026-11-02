import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextCardStore, flattenCard } from '../context-cards.mjs';

const verifiedFacts = { sourceChannel: 'ExampleBroadcaster', destinationChannel: 'ReceivingChannel', viewerCount: 42, receivedAt: '2026-11-01T12:00:00.000Z' };
const generatedResult = {
  card: {
    whatsHappening: 'The final challenge is underway.',
    communityDiscussed: 'Chat is comparing two routes.',
    newcomersMissed: 'The eastern gate was reached during the challenge.',
    continued: 'The same route discussion continues after the raid.',
    changed: null,
    participationPrompt: 'Which route would you try?'
  }
};

test('new AI draft is private from OBS, and public dashboard output excludes evidence quotes and chat identity fields', () => {
  const store = new ContextCardStore();
  store.beginRaid('raid-1', verifiedFacts);
  store.setStatus('raid-1', 'generating', 'Comparing both windows.');
  const draftId = store.createDraft('raid-1', generatedResult);
  assert.ok(draftId);
  const dashboard = store.dashboardView();
  assert.equal(dashboard.status, 'draft');
  assert.equal(dashboard.draft.approved, false);
  assert.equal(dashboard.raidFacts.verifiedBy, 'Twitch EventSub');
  assert.deepEqual(store.approvedView(), { approved: false });
  const serialized = JSON.stringify(dashboard);
  assert.equal(serialized.includes('quote'), false);
  assert.equal(serialized.includes('chatter_user_id'), false);
  assert.equal(serialized.includes('chatter_user_name'), false);
});

test('only the matching streamer approval publishes edited content to OBS; dismiss clears it', () => {
  const store = new ContextCardStore();
  store.beginRaid('raid-1', verifiedFacts);
  const draftId = store.createDraft('raid-1', generatedResult);
  assert.equal(store.approve('wrong-id', 'unapproved text'), false);
  assert.deepEqual(store.approvedView(), { approved: false });
  assert.equal(store.approve(draftId, ''), false);
  assert.equal(store.approve(draftId, 'Streamer-edited bridge.'), true);
  const approved = store.approvedView();
  assert.equal(approved.approved, true);
  assert.equal(approved.text, 'Streamer-edited bridge.');
  assert.equal(approved.raidFacts.verifiedBy, 'Twitch EventSub');
  assert.equal(store.dashboardView().draft.approved, true);
  assert.equal(store.dismiss('stale-id'), false);
  assert.equal(store.dismiss(draftId), true);
  assert.deepEqual(store.approvedView(), { approved: false });
});

test('new raid invalidates any previous approval and flattens a bounded structured card', () => {
  const store = new ContextCardStore();
  store.beginRaid('raid-1', verifiedFacts);
  const draftId = store.createDraft('raid-1', generatedResult);
  store.approve(draftId, 'approved first raid');
  store.beginRaid('raid-2', { ...verifiedFacts, viewerCount: 7 });
  assert.deepEqual(store.approvedView(), { approved: false });
  assert.equal(store.dashboardView().status, 'collecting');
  assert.match(flattenCard(generatedResult.card), /THE CONVERSATION: Chat is comparing two routes\./);
  assert.doesNotMatch(flattenCard(generatedResult.card), /WHAT CHANGED:/);
});
