import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatContextWindows } from '../chat-context.mjs';
import { ContextCardStore } from '../context-cards.mjs';
import { generateConversationIntelligence } from '../conversation-intelligence.mjs';

const preText = [
  'Chat discusses the no-fast-travel boss route.',
  'They are testing a charm build for the eastern gate.',
  'The route avoids fast travel before the final fight.'
];
const postText = [
  'The no-fast-travel route reached the eastern gate.',
  'The final fight is still ahead.',
  'Quick Focus might help with this boss.'
];
const claim = (text, ...evidence) => ({ text, evidence });
const evidence = (window, messageIndex, text) => ({ window, messageIndex, quote: text });

function mockedResult() {
  const pre = index => evidence('pre', index, preText[index]);
  const post = index => evidence('post', index, postText[index]);
  return {
    status: 'sufficient',
    preRaidAnalysis: {
      topic: claim('Chat discusses the no-fast-travel boss route.', pre(0)),
      activity: claim('They are testing a charm build for the eastern gate.', pre(1)),
      relevantContext: claim('The route avoids fast travel before the final fight.', pre(2))
    },
    postRaidAnalysis: {
      topic: claim('The no-fast-travel route reached the eastern gate.', post(0)),
      activity: claim('The final fight is still ahead.', post(1))
    },
    comparison: {
      continued: claim('The no-fast-travel route remains active after the raid.', pre(2), post(0)),
      changed: claim('The eastern gate was reached.', pre(1), post(0)),
      newcomersMissed: claim('The route avoids fast travel before the final fight.', pre(2), post(1))
    },
    card: {
      whatsHappening: claim('The final fight is still ahead.', post(1)),
      communityDiscussed: claim('Chat discusses the no-fast-travel boss route.', pre(0)),
      newcomersMissed: claim('The route avoids fast travel before the final fight.', pre(2), post(1)),
      continued: claim('The no-fast-travel route remains active after the raid.', pre(2), post(0)),
      changed: claim('The eastern gate was reached.', pre(1), post(0)),
      participationPrompt: claim('Which route for the final fight?', pre(2))
    }
  };
}

test('synthetic raid flow freezes chat, validates a mocked AI draft, and exposes only streamer-approved OBS content', async () => {
  let now = 1000;
  const chat = new ChatContextWindows({ now: () => now });
  const add = (id, text) => chat.add({
    message: { text }, chatter_user_name: `synthetic-viewer-${id}`, chatter_user_id: `private-id-${id}`
  }, id);
  preText.forEach((text, index) => { assert.equal(add(`pre-${index}`, text), true); now += 10; });
  assert.equal(add('pre-0', preText[0]), false, 'duplicate message IDs are ignored before the raid.');

  const raid = {
    id: 'synthetic-raid-1',
    from_broadcaster_user_name: 'SyntheticSource',
    to_broadcaster_user_name: 'SyntheticReceiver',
    viewers: 7
  };
  const receivedAt = now;
  assert.equal(chat.beginRaid(raid.id, receivedAt), true);
  assert.equal(chat.beginRaid(raid.id, receivedAt), false, 'duplicate raid IDs are ignored.');
  const cards = new ContextCardStore();
  cards.beginRaid(raid.id, {
    sourceChannel: raid.from_broadcaster_user_name,
    destinationChannel: raid.to_broadcaster_user_name,
    viewerCount: raid.viewers,
    receivedAt: new Date(receivedAt).toISOString(),
    synthetic: true
  });

  postText.forEach((text, index) => { now += 10; assert.equal(add(`post-${index}`, text), true); });
  assert.equal(add('post-0', postText[0]), false, 'duplicate post-raid message IDs are ignored.');
  const snapshot = chat.snapshot();
  assert.deepEqual(snapshot.pre.map(message => message.text), preText);
  assert.deepEqual(snapshot.post.map(message => message.text), postText);
  const publicMessages = JSON.stringify(snapshot);
  assert.doesNotMatch(publicMessages, /synthetic-viewer|private-id/);

  let requestCount = 0;
  const mockFetch = async (_url, init) => {
    requestCount++;
    const request = JSON.parse(init.body);
    assert.equal(request.store, false);
    assert.deepEqual(request.tools, []);
    assert.doesNotMatch(request.input[1].content, /synthetic-viewer|private-id/);
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(mockedResult()) }) };
  };
  await assert.rejects(generateConversationIntelligence({
    preMessages: snapshot.pre.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    postMessages: snapshot.post.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    apiKey: 'synthetic-test-key', consentEnabled: false, fetchImpl: mockFetch
  }), error => error.kind === 'consent_required');
  assert.equal(requestCount, 0, 'mock model must not be called without isolated-test consent.');
  const result = await generateConversationIntelligence({
    preMessages: snapshot.pre.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    postMessages: snapshot.post.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    apiKey: 'synthetic-test-key',
    consentEnabled: true,
    fetchImpl: mockFetch
  });

  assert.equal(requestCount, 1);
  assert.equal(result.status, 'sufficient');
  const draftId = cards.createDraft(raid.id, result);
  assert.ok(draftId);
  assert.equal(cards.dashboardView().status, 'draft');
  assert.equal(cards.dashboardView().draft.approved, false);
  assert.deepEqual(cards.approvedView(), { approved: false });

  assert.equal(cards.approve(draftId, 'Streamer-edited synthetic bridge.'), true);
  const obsPayload = cards.approvedView();
  assert.equal(obsPayload.approved, true);
  assert.equal(obsPayload.text, 'Streamer-edited synthetic bridge.');
  assert.equal(obsPayload.raidFacts.synthetic, true);
  assert.equal(obsPayload.raidFacts.verifiedBy, 'Synthetic test fixture');

  cards.beginRaid('synthetic-raid-2', { sourceChannel: 'NextSyntheticSource' });
  assert.deepEqual(cards.approvedView(), { approved: false });
  const nextDraftId = cards.createDraft('synthetic-raid-2', result);
  assert.ok(nextDraftId);
  assert.equal(cards.approve(nextDraftId, 'Temporary synthetic approval.'), true);
  assert.equal(cards.approvedView().approved, true);
  assert.equal(cards.dismiss(nextDraftId), true);
  assert.deepEqual(cards.approvedView(), { approved: false }, 'dismissal removes the approved OBS card.');
  assert.equal(requestCount, 1, 'all simulated model activity used one mocked response.');
});
