import { randomUUID } from 'node:crypto';

const MAX_CARD_LENGTH = 1000;

function safeRaidFacts(facts) {
  if (!facts || typeof facts !== 'object') return null;
  return {
    sourceChannel: typeof facts.sourceChannel === 'string' ? facts.sourceChannel.slice(0, 80) : 'Unknown channel',
    destinationChannel: typeof facts.destinationChannel === 'string' ? facts.destinationChannel.slice(0, 80) : 'Connected channel',
    viewerCount: Number.isInteger(facts.viewerCount) && facts.viewerCount >= 0 ? facts.viewerCount : null,
    receivedAt: typeof facts.receivedAt === 'string' ? facts.receivedAt : new Date().toISOString(),
    verifiedBy: 'Twitch EventSub'
  };
}

export function flattenCard(card) {
  const rows = [
    ['RIGHT NOW', card.whatsHappening],
    ['THE CONVERSATION', card.communityDiscussed],
    ['WHAT YOU MISSED', card.newcomersMissed],
    ['STILL GOING', card.continued],
    ['WHAT CHANGED', card.changed],
    ['JUMP IN IF YOU LIKE', card.participationPrompt]
  ].filter(([, value]) => typeof value === 'string' && value.trim());
  return rows.map(([label, value]) => `${label}: ${value.trim()}`).join('\n');
}

export class ContextCardStore {
  constructor() { this.current = { raidId: null, status: 'idle', message: 'Waiting for a real Twitch raid.', raidFacts: null, draft: null, approved: null }; }

  clear() { this.current = { raidId: null, status: 'idle', message: 'Waiting for a real Twitch raid.', raidFacts: null, draft: null, approved: null }; }
  currentRaidId() { return this.current.raidId; }

  beginRaid(raidId, facts) {
    this.current = {
      raidId,
      status: 'collecting',
      message: 'Capturing a short conversation window before creating a draft.',
      raidFacts: safeRaidFacts(facts),
      draft: null,
      approved: null
    };
  }

  setStatus(raidId, status, message) {
    if (this.current.raidId !== raidId) return false;
    this.current.status = status;
    this.current.message = message;
    return true;
  }

  createDraft(raidId, card) {
    if (this.current.raidId !== raidId) return null;
    const text = flattenCard(card.card);
    const draft = {
      id: randomUUID(),
      text,
      card: {
        whatsHappening: card.card.whatsHappening,
        communityDiscussed: card.card.communityDiscussed,
        newcomersMissed: card.card.newcomersMissed,
        continued: card.card.continued,
        changed: card.card.changed,
        participationPrompt: card.card.participationPrompt
      },
      generatedAt: new Date().toISOString()
    };
    this.current.status = 'draft';
    this.current.message = 'AI draft is ready for your review. It is private until you approve it.';
    this.current.draft = draft;
    this.current.approved = null;
    return draft.id;
  }

  approve(draftId, text) {
    const draft = this.current.draft;
    if (!draft || draft.id !== draftId || typeof text !== 'string') return false;
    const edited = text.trim();
    if (!edited || edited.length > MAX_CARD_LENGTH) return false;
    this.current.status = 'approved';
    this.current.message = 'Streamer approved. The card is available in the OBS browser source.';
    this.current.draft = { ...draft, text: edited };
    this.current.approved = { text: edited, raidFacts: this.current.raidFacts, approvedAt: new Date().toISOString() };
    return true;
  }

  dismiss(draftId) {
    if (!this.current.draft || this.current.draft.id !== draftId) return false;
    this.current.status = 'dismissed';
    this.current.message = 'The draft was dismissed. Nothing from this raid is shown in OBS.';
    this.current.draft = null;
    this.current.approved = null;
    return true;
  }

  dashboardView() {
    const { status, message, raidFacts, draft } = this.current;
    return { status, message, raidFacts, draft: draft ? { ...draft, approved: status === 'approved' } : null };
  }

  approvedView() {
    if (!this.current.approved) return { approved: false };
    return { approved: true, text: this.current.approved.text, raidFacts: this.current.approved.raidFacts, approvedAt: this.current.approved.approvedAt };
  }
}
