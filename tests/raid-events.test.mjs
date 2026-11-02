import test from 'node:test';
import assert from 'node:assert/strict';
import { RaidEventStore } from '../raid-events.mjs';

test('raid event store ignores duplicate Twitch message IDs', () => {
  const store = new RaidEventStore({ now: () => 1_800_000_000_000 });
  const raid = { from_broadcaster_user_name: 'RaidSource', to_broadcaster_user_name: 'Channel', viewers: 82 };
  assert.equal(store.add(raid, 'event-1'), true);
  assert.equal(store.add(raid, 'event-1'), false);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].viewers, 82);
});

test('raid event store expires dedupe keys and caps its history', () => {
  let now = 10_000;
  const store = new RaidEventStore({ maxEvents: 2, dedupeTtlMs: 100, now: () => now });
  store.add({ viewers: 1 }, 'one');
  now += 1;
  store.add({ viewers: 2 }, 'two');
  now += 1;
  store.add({ viewers: 3 }, 'three');
  assert.deepEqual(store.list().map(event => event.id), ['three', 'two']);
  now += 101;
  assert.equal(store.add({ viewers: 4 }, 'one'), true);
});
