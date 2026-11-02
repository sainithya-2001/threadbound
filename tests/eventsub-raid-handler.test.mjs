import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatContextWindows } from '../chat-context.mjs';
import { ContextCardStore } from '../context-cards.mjs';
import { generateConversationIntelligence } from '../conversation-intelligence.mjs';
import { RaidEventStore } from '../raid-events.mjs';
import { parseEventSubEnvelope, processChannelRaidNotification } from '../eventsub-raid-handler.mjs';

const broadcasterId = 'receiver-1';
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

function makeRaidEnvelope(messageId, destination = broadcasterId) {
  return {
    metadata: { message_type: 'notification', message_id: messageId },
    payload: {
      subscription: { type: 'channel.raid', version: '1' },
      event: {
        from_broadcaster_user_id: 'source-1',
        from_broadcaster_user_login: 'synthetic_source',
        from_broadcaster_user_name: 'Synthetic Source',
        to_broadcaster_user_id: destination,
        to_broadcaster_user_login: 'synthetic_receiver',
        to_broadcaster_user_name: 'Synthetic Receiver',
        viewers: 7
      }
    }
  };
}

function evidence(window, messageIndex) {
  return { window, messageIndex, quote: (window === 'pre' ? preText : postText)[messageIndex] };
}
function claim(text, ...refs) { return { text, evidence: refs }; }
function mockStructuredResponse() {
  const pre = index => evidence('pre', index);
  const post = index => evidence('post', index);
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

test('production EventSub raid processor matches destination, freezes context, and reaches a mocked draft', async () => {
  let now = 1_000;
  const chatWindows = new ChatContextWindows({ now: () => now });
  const raidEvents = new RaidEventStore({ now: () => now });
  const cards = new ContextCardStore();
  const onAccepted = [];
  for (let index = 0; index < preText.length; index++) {
    assert.equal(chatWindows.add({ message: { text: preText[index] }, chatter_user_id: `private-${index}` }, `pre-${index}`), true);
    now += 10;
  }

  assert.equal(parseEventSubEnvelope('{not-json'), null);
  const wrongDestination = processChannelRaidNotification({
    envelope: parseEventSubEnvelope(JSON.stringify(makeRaidEnvelope('wrong-destination-event', 'someone-else'))),
    broadcasterId, raidEvents, chatWindows,
    onAcceptedRaid: (...args) => onAccepted.push(args),
    now: () => now
  });
  assert.deepEqual(wrongDestination, { handled: true, accepted: false, reason: 'destination_mismatch' });
  assert.equal(raidEvents.list().length, 0, 'a mismatched destination is not recorded in the connected channel');
  assert.equal(chatWindows.snapshot(), null, 'a mismatched destination cannot freeze the active chat window');
  assert.equal(onAccepted.length, 0);

  const rawCliStyleMessage = JSON.stringify(makeRaidEnvelope('synthetic-cli-raid-1'));
  const envelope = parseEventSubEnvelope(rawCliStyleMessage);
  assert.equal(envelope.payload.event.to_broadcaster_user_id, broadcasterId);
  const accepted = processChannelRaidNotification({
    envelope, broadcasterId, raidEvents, chatWindows, now: () => now,
    onAcceptedRaid: (raidId, event, receivedAt) => {
      onAccepted.push({ raidId, event, receivedAt });
      cards.beginRaid(raidId, {
        sourceChannel: event.from_broadcaster_user_name,
        destinationChannel: event.to_broadcaster_user_name,
        viewerCount: event.viewers,
        receivedAt: new Date(receivedAt).toISOString(),
        synthetic: true
      });
    }
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.eventId, 'synthetic-cli-raid-1');
  assert.equal(onAccepted.length, 1);
  assert.equal(raidEvents.list()[0].toBroadcasterId, broadcasterId);
  assert.equal(raidEvents.list()[0].viewers, 7);
  assert.deepEqual(chatWindows.snapshot().pre.map(message => message.text), preText, 'pre-raid messages are frozen at the notification timestamp');
  assert.equal(cards.dashboardView().raidFacts.synthetic, true, 'fixture facts remain labeled synthetic');

  const duplicate = processChannelRaidNotification({ envelope, broadcasterId, raidEvents, chatWindows, now: () => now, onAcceptedRaid: () => assert.fail('duplicate raid must not run downstream') });
  assert.deepEqual(duplicate, { handled: true, accepted: false, reason: 'duplicate_event' });
  assert.equal(onAccepted.length, 1);

  for (let index = 0; index < postText.length; index++) {
    now += 10;
    assert.equal(chatWindows.add({ message: { text: postText[index] }, chatter_user_name: `synthetic-viewer-${index}` }, `post-${index}`), true);
  }
  const snapshot = chatWindows.snapshot();
  assert.deepEqual(snapshot.pre.map(message => message.text), preText);
  assert.deepEqual(snapshot.post.map(message => message.text), postText);

  let mockCalls = 0;
  const result = await generateConversationIntelligence({
    preMessages: snapshot.pre.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    postMessages: snapshot.post.map((message, messageIndex) => ({ messageIndex, text: message.text })),
    apiKey: 'synthetic-test-only',
    consentEnabled: true,
    fetchImpl: async (_url, init) => {
      mockCalls++;
      assert.equal(JSON.parse(init.body).store, false);
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(mockStructuredResponse()) }) };
    }
  });
  const draftId = cards.createDraft(accepted.eventId, result);
  assert.ok(draftId);
  assert.equal(mockCalls, 1, 'the downstream conversation engine used only its injected mock response');
  assert.equal(cards.dashboardView().status, 'draft');
  assert.equal(cards.dashboardView().draft.approved, false);
  assert.deepEqual(cards.approvedView(), { approved: false });
});

test('production EventSub raid processor ignores non-raid and malformed raid notifications', () => {
  const raidEvents = new RaidEventStore();
  const chatWindows = new ChatContextWindows({ now: () => 1_000 });
  const onAcceptedRaid = () => assert.fail('invalid notifications must not be processed');
  assert.equal(processChannelRaidNotification({
    envelope: { metadata: { message_type: 'notification' }, payload: { subscription: { type: 'channel.chat.message' } } },
    broadcasterId, raidEvents, chatWindows, onAcceptedRaid
  }).handled, false);
  assert.deepEqual(processChannelRaidNotification({
    envelope: {
      ...makeRaidEnvelope('invalid-event'),
      payload: { subscription: { type: 'channel.raid' }, event: { from_broadcaster_user_id: 'source-1', to_broadcaster_user_id: broadcasterId, viewers: '7' } }
    },
    broadcasterId, raidEvents, chatWindows, onAcceptedRaid
  }), { handled: true, accepted: false, reason: 'invalid_raid_event' });
  assert.equal(raidEvents.list().length, 0);
  assert.equal(chatWindows.snapshot(), null);
});
