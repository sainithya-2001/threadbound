const textarea = document.querySelector('#card-edit');
const count = document.querySelector('#char-count');
const approve = document.querySelector('#approve-button');
const dismiss = document.querySelector('#dismiss-button');
const toast = document.querySelector('#toast');
const STORAGE_KEY = 'raidbridge-approved-card-v1';
let liveConnected = false;
let renderedLiveDraftId = null;
let renderedLiveDraftApproved = false;
let liveDraftEdited = false;
let liveDraftSnapshot = null;
let aiConsentEnabled = false;
let aiConsentPending = false;
let aiConsentDemoLocked = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('visible'), 2800);
}
function updateCount() { count.textContent = `${textarea.value.length} / 320`; }
function syncSampleOverlayStatus() {
  let approved = false;
  try { const card = JSON.parse(localStorage.getItem(STORAGE_KEY)); approved = card?.source === 'sample' && card?.approved === true && Boolean(card?.text?.trim()); } catch { /* invalid demo storage is treated as empty */ }
  document.querySelector('.overlay-status-card strong').textContent = approved ? 'Approved sample is in OBS' : 'OBS overlay is waiting';
  document.querySelector('.overlay-status-card span:not(.overlay-status-icon)').textContent = approved ? 'Your approved sample card is showing in the demo overlay.' : 'Approve a sample card to preview it in demo mode.';
}
textarea.addEventListener('input', updateCount);
updateCount();

approve.addEventListener('click', () => {
  if (liveConnected) { showToast('Review the live conversation card in the Conversation Bridge panel.'); return; }
  const text = textarea.value.trim();
  if (!text) { showToast('Add context to the card before approving it.'); return; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, source: 'sample', approved: true, approvedAt: Date.now() }));
  approve.innerHTML = '<span>✓</span> Approved for OBS';
  approve.classList.add('approved');
  document.querySelector('.review-status').innerHTML = '<span class="approved-dot"></span> APPROVED';
  document.querySelector('.draft-note').innerHTML = '<span class="lock-icon">✓</span><span>Your approved card is now visible in the OBS overlay.</span>';
  syncSampleOverlayStatus();
  showToast('Approved. Your card is now visible in OBS.');
});

dismiss.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  approve.innerHTML = '<span>✓</span> Approve for OBS';
  approve.classList.remove('approved');
  document.querySelector('.review-status').innerHTML = '<span></span> NEEDS APPROVAL';
  document.querySelector('.draft-note').innerHTML = '<span class="lock-icon">⌑</span><span>This is a private draft. It won\'t appear on stream until you approve it.</span>';
  syncSampleOverlayStatus();
  showToast('Draft dismissed. The OBS overlay is clear.');
});

const liveCardEdit = document.querySelector('#live-card-edit');
const liveCardApprove = document.querySelector('#live-approve-button');
const liveCardDismiss = document.querySelector('#live-dismiss-button');
const liveCardCharCount = document.querySelector('#live-card-char-count');
const aiConsentToggle = document.querySelector('#ai-consent-toggle');
liveCardEdit.addEventListener('input', () => {
  liveDraftEdited = true;
  liveCardCharCount.textContent = `${liveCardEdit.value.length} / 1000`;
  renderLiveClaims(liveDraftSnapshot);
});
liveCardApprove.addEventListener('click', async () => {
  const draftId = renderedLiveDraftId;
  if (!draftId || !liveCardEdit.value.trim()) return showToast('A live draft is not ready to approve.');
  liveCardApprove.disabled = true;
  try {
    const response = await fetch('/api/context/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, text: liveCardEdit.value })
    });
    if (!response.ok) throw new Error('Approval failed. Refresh the dashboard and review the current draft.');
    showToast('Approved. The streamer-approved card is now available in OBS.');
    await pollStatus();
  } catch (error) { showToast(error.message || 'Approval failed.'); }
  finally { liveCardApprove.disabled = renderedLiveDraftApproved; }
});
liveCardDismiss.addEventListener('click', async () => {
  if (!renderedLiveDraftId) return;
  try {
    const response = await fetch('/api/context/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: renderedLiveDraftId })
    });
    if (!response.ok) throw new Error('Dismiss failed. Refresh the dashboard and review the current draft.');
    showToast('Dismissed. The OBS card has been cleared.');
    await pollStatus();
  } catch (error) { showToast(error.message || 'Dismiss failed.'); }
});

aiConsentToggle.addEventListener('change', async () => {
  const requested = aiConsentToggle.checked;
  const previous = aiConsentEnabled;
  aiConsentPending = true;
  aiConsentToggle.disabled = true;
  renderAiConsent({ enabled: requested, optimistic: true });
  try {
    const response = await fetch('/api/context/consent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: requested })
    });
    if (!response.ok) throw new Error('Consent could not be saved.');
    const result = await response.json();
    aiConsentEnabled = result.enabled === true;
    showToast(aiConsentEnabled ? 'AI chat analysis enabled for future raid drafts.' : 'AI chat analysis is off. Future OpenAI requests are blocked.');
  } catch {
    aiConsentEnabled = previous;
    document.querySelector('#ai-consent-panel').dataset.error = 'true';
    document.querySelector('#ai-consent-status').textContent = 'SETTING NOT SAVED';
    document.querySelector('#ai-consent-detail').textContent = 'The server did not confirm this change. Check the connection and try again.';
  } finally {
    aiConsentPending = false;
    aiConsentToggle.disabled = false;
    renderAiConsent({ enabled: aiConsentEnabled });
  }
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Just received' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}
function renderRaids(raids) {
  const list = document.querySelector('#live-raid-list');
  if (!raids.length) {
    list.innerHTML = '<div class="live-empty"><span>⌁</span><div><strong>Listening for the next arrival</strong><small>New channel.raid events from Twitch will appear here.</small></div></div>';
    return;
  }
  list.innerHTML = raids.map(raid => {
    const synthetic = raid.synthetic === true;
    return `<div class="live-raid-event"><div class="live-event-avatar">${escapeHtml((raid.fromBroadcasterName || '?').slice(0, 1).toUpperCase())}</div><div class="live-event-copy"><strong>${escapeHtml(raid.fromBroadcasterName || raid.fromBroadcasterLogin || 'Unknown channel')} <span>raided</span></strong><small>${escapeHtml(raid.viewers)} viewers → ${escapeHtml(raid.toBroadcasterName || raid.toBroadcasterLogin || 'your channel')}</small></div><time>${escapeHtml(formatTime(raid.receivedAt))}</time><span class="verified-event">${synthetic ? 'SYNTHETIC TEST' : '✓ TWITCH EVENT'}</span></div>`;
  }).join('');
}
function renderConnection(state) {
  renderAiConsent(state.aiConsent, state.demoMode === true, state.simulationMode === true);
  const connectionName = document.querySelector('#connection-name');
  const connectionDetail = document.querySelector('#connection-detail');
  const livePill = document.querySelector('#mode-pill');
  const connect = document.querySelector('#twitch-connect');
  const list = document.querySelector('#live-raid-list');
  const sampleBanner = document.querySelector('#sample-banner');
  if (state.simulationMode === true) {
    connectionName.textContent = 'Simulation workspace'; connectionDetail.textContent = 'No Twitch services connected';
    document.querySelector('#profile-name').textContent = 'Synthetic broadcaster';
    document.querySelector('#profile-detail').textContent = 'Fixture data only';
    document.querySelector('#profile-avatar').textContent = 'ST';
    document.querySelector('#connection-led').classList.remove('is-connected');
    livePill.innerHTML = '<span></span> SIMULATION MODE';
    connect.style.display = 'none';
    list.hidden = false;
    sampleBanner.hidden = false;
    document.querySelector('#sample-banner-title').textContent = 'Synthetic test data · not from Twitch';
    document.querySelector('#sample-banner-copy').textContent = 'This isolated test uses synthetic chat, a mocked raid event, and a mocked OpenAI response. No external service is contacted.';
    document.querySelector('#sample-banner-tag').textContent = 'TEST ONLY';
    document.querySelectorAll('.sample-only').forEach(el => { el.hidden = true; });
    document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = true; });
    document.querySelector('#integration-health').hidden = true;
    document.querySelector('#disconnect-button').hidden = true;
    document.querySelector('#live-context-panel').hidden = false;
    document.querySelector('.raid-panel .panel-heading h2').textContent = 'Synthetic raid arrivals';
    document.querySelector('.raid-panel .panel-heading .data-tag').innerHTML = '<span class="data-dot"></span> SYNTHETIC EVENTS';
    renderRaids(state.raids || []);
    renderLiveContext(state.context || { status: 'idle', message: 'Waiting for synthetic test data.' }, true);
    return;
  }
  const live = Boolean(state.connected && state.broadcaster);
  const wasLive = liveConnected;
  liveConnected = live;
  if (!state.configured && !live) {
    document.querySelector('#live-context-panel').hidden = true;
    syncSampleOverlayStatus();
    document.querySelector('#integration-health').hidden = true;
    if (state.demoMode === true) {
      connectionName.textContent = 'Demo workspace'; connectionDetail.textContent = 'Twitch and OpenAI integrations are disabled';
      livePill.innerHTML = '<span></span> DEMO MODE'; connect.style.display = 'none';
      list.hidden = true; sampleBanner.hidden = false;
      document.querySelector('#sample-banner-title').textContent = "You're exploring with sample data";
      document.querySelector('#sample-banner-copy').textContent = 'This preview is isolated. Twitch, chat capture, EventSub, token storage, and OpenAI are disabled.';
      document.querySelector('#sample-banner-tag').textContent = 'SAMPLE ONLY';
      document.querySelectorAll('.sample-only').forEach(el => { el.hidden = false; });
      document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = false; });
      document.querySelector('.raid-panel .panel-heading h2').textContent = 'A raid just came in';
      document.querySelector('.raid-panel .data-tag').innerHTML = '<span class="data-dot"></span> SAMPLE EVENT';
      return;
    }
    if (state.oauthCanStart) {
      connectionName.textContent = 'Twitch app ready'; connectionDetail.textContent = 'Local Client Secret needed to finish';
      livePill.innerHTML = '<span></span> TWITCH READY'; connect.style.display = '';
      connect.href = '/auth/twitch'; connect.title = 'Start Twitch sign-in; the local Client Secret is still needed to finish';
      list.hidden = true; sampleBanner.hidden = false;
      document.querySelectorAll('.sample-only').forEach(el => { el.hidden = false; });
      document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = false; });
      return;
    }
    connectionName.textContent = 'Demo workspace'; connectionDetail.textContent = 'Not connected to Twitch';
    livePill.innerHTML = '<span></span> DEMO MODE'; connect.style.display = '';
    connect.href = '/auth/twitch'; connect.title = 'Add Twitch app credentials to connect';
    list.hidden = true; sampleBanner.hidden = false;
    document.querySelectorAll('.sample-only').forEach(el => { el.hidden = false; });
    document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = false; });
    document.querySelector('.raid-panel .panel-heading h2').textContent = 'A raid just came in';
    document.querySelector('.raid-panel .data-tag').innerHTML = '<span class="data-dot"></span> SAMPLE EVENT';
    return;
  }
  if (!live) {
    document.querySelector('#live-context-panel').hidden = true;
    syncSampleOverlayStatus();
    document.querySelector('#integration-health').hidden = true;
    connectionName.textContent = 'Twitch app ready'; connectionDetail.textContent = 'Connect a broadcaster account';
    livePill.innerHTML = '<span></span> READY TO CONNECT'; connect.style.display = '';
    connect.href = '/auth/twitch'; connect.title = 'Connect Twitch'; list.hidden = true;
    sampleBanner.hidden = false; document.querySelectorAll('.sample-only').forEach(el => { el.hidden = false; });
    document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = false; });
    return;
  }
  connectionName.textContent = state.broadcaster.name;
  connectionDetail.textContent = 'Twitch · OAuth connected';
  document.querySelector('#profile-avatar').textContent = state.broadcaster.name.slice(0, 2).toUpperCase();
  document.querySelector('#profile-name').textContent = state.broadcaster.name;
  document.querySelector('#profile-detail').textContent = 'Connected broadcaster';
  document.querySelector('#connection-led').classList.add('is-connected');
  livePill.innerHTML = '<span></span> TWITCH CONNECTED';
  connect.style.display = 'none';
  list.hidden = false;
  document.querySelector('#integration-health').hidden = false;
  sampleBanner.hidden = false;
  document.querySelector('#sample-banner-title').textContent = 'Live Twitch events · conversation sample paused';
  document.querySelector('#sample-banner-copy').textContent = state.chat?.collectionActive
    ? 'Raid events and bounded chat capture are real Twitch data. A private conversation draft will be created after a real raid; sample conversation stays out of live context.'
    : 'Raid events below are real Twitch data. Chat capture waits for its Twitch permission; the conversation sample stays labeled and is not live context.';
  document.querySelector('#sample-banner-tag').textContent = state.chat?.collectionActive ? 'LIVE CHAT' : 'CHAT PERMISSION';
  document.querySelectorAll('.sample-only').forEach(el => { el.hidden = true; });
  document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = true; });
  document.querySelector('#live-context-panel').hidden = false;
  document.querySelector('.raid-panel .panel-heading h2').textContent = 'Live raid arrivals';
  document.querySelector('.raid-panel .panel-heading .data-tag').innerHTML = '<span class="data-dot"></span> REAL TWITCH EVENTS';
  document.querySelector('#disconnect-button').hidden = false;
  updateHealth('oauth-health', true, 'Connected');
  updateHealth('eventsub-health', Boolean(state.eventSub?.connected), eventSubLabel(state.eventSub));
  updateHealth('raid-health', Boolean(state.raidSubscription?.enabled), raidSubscriptionLabel(state.raidSubscription));
  const chatReady = Boolean(state.chat?.collectionActive);
  updateHealth('chat-health', chatReady, chatLabel(state.chat));
  const chatAuthorize = document.querySelector('#chat-authorize');
  chatAuthorize.hidden = Boolean(state.chat?.authorized && state.chat?.status !== 'error');
  chatAuthorize.textContent = state.chat?.status === 'error' ? 'Retry chat authorization' : 'Authorize chat context';
  if (!wasLive) showToast('Twitch connected. Listening for raid arrivals.');
  renderRaids(state.raids || []);
  renderLiveContext(state.context || { status: 'idle', message: 'Waiting for a real Twitch raid.' });
}

function renderAiConsent(consent = {}, demoMode = aiConsentDemoLocked, simulationMode = false) {
  aiConsentDemoLocked = demoMode === true || simulationMode === true;
  if (aiConsentPending && !consent.optimistic) return;
  const enabled = typeof consent.enabled === 'boolean' ? consent.enabled : aiConsentEnabled;
  aiConsentEnabled = enabled;
  const panel = document.querySelector('#ai-consent-panel');
  aiConsentToggle.checked = enabled;
  aiConsentToggle.disabled = aiConsentDemoLocked || aiConsentPending;
  aiConsentToggle.setAttribute('aria-checked', String(enabled));
  panel.dataset.enabled = String(enabled);
  panel.dataset.error = 'false';
  document.querySelector('#ai-consent-status').textContent = simulationMode
    ? 'SIMULATION · MOCKED AI ONLY'
    : aiConsentDemoLocked
    ? 'DEMO MODE · AI ANALYSIS DISABLED'
    : enabled ? 'ON · BOUNDED CHAT MAY BE SENT TO OPENAI' : 'OFF · NO CHAT SENT TO OPENAI';
  document.querySelector('#ai-consent-detail').textContent = simulationMode
    ? 'Fixture responses are mocked in this isolated test. No chat or content is sent to OpenAI.'
    : aiConsentDemoLocked
    ? 'This isolated preview cannot send chat or other content to OpenAI.'
    : enabled
    ? 'Only message text from the bounded windows is sent after a real raid. Turning this off blocks future requests.'
    : 'Twitch chat capture is independent. No chat content will be sent for AI analysis.';
}

function renderLiveContext(context, simulationMode = false) {
  const title = document.querySelector('#live-context-title');
  const stateTag = document.querySelector('#live-context-state');
  const message = document.querySelector('#live-context-message');
  const facts = document.querySelector('#verified-raid-facts');
  const claims = document.querySelector('#live-context-claims');
  const draftWrap = document.querySelector('#live-context-draft');
  const draft = context?.draft;
  const status = context?.status || 'idle';
  title.textContent = draft ? (draft.approved ? 'Approved for your scene' : 'Ready for your review') : contextTitle(status);
  stateTag.textContent = draft?.approved ? 'APPROVED' : statusLabelContext(status);
  stateTag.classList.toggle('context-approved-state', Boolean(draft?.approved));
  stateTag.classList.toggle('context-error-state', status === 'error');
  message.hidden = Boolean(draft);
  message.textContent = context?.message || 'Waiting for a real Twitch raid.';
  message.dataset.tone = status === 'error' ? 'error' : status === 'insufficient' || status === 'unavailable' ? 'insufficient' : '';
  const raidFacts = context?.raidFacts;
  facts.hidden = !raidFacts;
  if (raidFacts) {
    const count = Number.isInteger(raidFacts.viewerCount) ? `${raidFacts.viewerCount.toLocaleString()} viewers` : 'viewer count unavailable';
    document.querySelector('#verified-raid-copy').textContent = `${raidFacts.sourceChannel} raided ${raidFacts.destinationChannel} · ${count}`;
    document.querySelector('#verified-raid-facts label').textContent = raidFacts.synthetic === true ? 'SYNTHETIC TEST EVENT · NOT FROM TWITCH' : 'VERIFIED EVENT · TWITCH EVENTSUB';
    document.querySelector('#verified-raid-time').textContent = raidFacts.synthetic === true
      ? `Fixture time ${formatTime(raidFacts.receivedAt)} · no real Twitch event`
      : `Received ${formatTime(raidFacts.receivedAt)} · verified Twitch EventSub metadata`;
  }
  draftWrap.hidden = !draft;
  if (!draft) {
    renderedLiveDraftId = null;
    renderedLiveDraftApproved = false;
    liveDraftEdited = false;
    liveDraftSnapshot = null;
    document.querySelector('.overlay-status-card strong').textContent = 'OBS overlay is waiting';
    document.querySelector('.overlay-status-card span:not(.overlay-status-icon)').textContent = 'A live context card will appear after you approve it.';
    return;
  }
  renderedLiveDraftApproved = Boolean(draft.approved);
  if (draft.id !== renderedLiveDraftId) {
    renderedLiveDraftId = draft.id;
    liveDraftEdited = false;
    liveCardEdit.value = draft.text;
  } else if (draft.approved && liveCardEdit.value !== draft.text) { liveCardEdit.value = draft.text; liveDraftEdited = false; }
  liveCardCharCount.textContent = `${liveCardEdit.value.length} / 1000`;
  liveDraftSnapshot = draft;
  renderLiveClaims(draft);
  document.querySelector('.context-ai-heading label').textContent = simulationMode ? 'MOCKED OPENAI RESPONSE · TEST ONLY' : 'AI-GENERATED CHAT SUMMARY';
  document.querySelector('.context-ai-heading small').textContent = simulationMode
    ? 'Built from synthetic fixture chat · no external OpenAI request'
    : 'Based on bounded pre-raid and post-raid messages · review before use';
  liveCardEdit.disabled = Boolean(draft.approved);
  liveCardApprove.disabled = Boolean(draft.approved);
  liveCardApprove.innerHTML = draft.approved ? '<span>✓</span> Approved for OBS' : '<span>✓</span> Approve for OBS';
  liveCardApprove.classList.toggle('approved', Boolean(draft.approved));
  document.querySelector('.overlay-status-card strong').textContent = draft.approved ? 'OBS overlay is live' : 'OBS overlay is waiting';
  document.querySelector('.overlay-status-card span:not(.overlay-status-icon)').textContent = draft.approved ? 'Your approved live card is being shown in the scene.' : 'Review and approve this live card to show it in the scene.';
}

function renderLiveClaims(draft) {
  const claims = document.querySelector('#live-context-claims');
  if (!draft) return claims.replaceChildren();
  if (draft.approved || liveDraftEdited) {
    const section = document.createElement('div'); section.className = 'context-claim';
    const heading = document.createElement('label'); heading.textContent = draft.approved ? 'STREAMER-APPROVED OBS PREVIEW' : 'YOUR EDITED PREVIEW';
    const copy = document.createElement('p'); copy.textContent = draft.approved ? draft.text : liveCardEdit.value;
    section.append(heading, copy); claims.replaceChildren(section); return;
  }
  const labels = [
    ['whatsHappening', 'RIGHT NOW'], ['communityDiscussed', 'THE CONVERSATION'],
    ['newcomersMissed', 'WHAT NEW ARRIVALS MAY HAVE MISSED'], ['continued', 'WHAT CONTINUED'],
    ['changed', 'WHAT CHANGED'], ['participationPrompt', 'OPTIONAL WAY TO JOIN']
  ];
  claims.replaceChildren(...labels.filter(([key]) => draft.card?.[key]).map(([key, label]) => {
    const section = document.createElement('div'); section.className = 'context-claim';
    const heading = document.createElement('label'); heading.textContent = label;
    const copy = document.createElement('p'); copy.textContent = draft.card[key];
    section.append(heading, copy); return section;
  }));
}

function contextTitle(status) {
  if (status === 'collecting') return 'Keeping the thread in view';
  if (status === 'generating') return 'Comparing both sides of the raid';
  if (status === 'insufficient') return 'Not enough conversation yet';
  if (status === 'unavailable') return 'Chat context is unavailable';
  if (status === 'consent_required') return 'AI analysis is off';
  if (status === 'consent_enabled') return 'Consent enabled for future raids';
  if (status === 'error') return 'Draft could not be generated';
  if (status === 'dismissed') return 'Card dismissed';
  return 'Listening for the thread';
}
function statusLabelContext(status) {
  return ({ idle: 'WAITING', collecting: 'CAPTURING', generating: 'COMPARING', draft: 'NEEDS APPROVAL', approved: 'APPROVED', dismissed: 'DISMISSED', insufficient: 'INSUFFICIENT CONTEXT', unavailable: 'CHAT UNAVAILABLE', consent_required: 'AI ANALYSIS OFF', consent_enabled: 'OPTED IN', error: 'GENERATION ERROR' })[status] || 'WAITING';
}
function updateHealth(prefix, isGood, label) {
  const dot = document.querySelector(`#${prefix}-dot`);
  const state = document.querySelector(`#${prefix}-state`);
  dot.classList.toggle('is-up', isGood);
  dot.classList.toggle('is-down', !isGood);
  state.textContent = label;
}
function eventSubLabel(eventSub = {}) {
  if (eventSub.connected) return 'Connected';
  if (eventSub.status === 'connecting') return 'Connecting';
  if (eventSub.status === 'reconnecting') return 'Reconnecting';
  return 'Disconnected';
}
function raidSubscriptionLabel(subscription = {}) {
  if (subscription.enabled) return 'Enabled';
  if (subscription.status === 'creating') return 'Creating';
  if (subscription.status === 'reconnecting') return 'Reconnecting';
  if (subscription.status === 'not_created' || subscription.status === 'not_found') return 'Not enabled';
  return 'Needs attention';
}
function chatLabel(chat = {}) {
  if (chat.collectionActive) return chat.window?.preCount ? `Capturing · ${chat.window.preCount} messages` : 'Capturing · waiting for chat';
  if (chat.status === 'permission_required') return 'Permission needed';
  if (chat.status === 'subscribing') return 'Subscribing';
  if (chat.status === 'waiting_for_eventsub') return 'Waiting for EventSub';
  if (chat.status === 'reconnecting') return 'Reconnecting';
  if (chat.status === 'error') return 'Needs attention';
  if (chat.status === 'not_connected') return 'Not connected';
  if (chat.subscriptionEnabled) return 'Ready · no messages yet';
  return 'Not enabled';
}
function statusLabel(status) {
  return ({ connecting: 'Connecting to EventSub', listening: 'Listening for raids', reconnecting: 'Reconnecting', subscription_error: 'Subscription needs attention' })[status] || status;
}
async function pollStatus() {
  try {
    const response = await fetch('/api/twitch/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Status request failed');
    renderConnection(await response.json());
  } catch { /* Keep the local demo usable when the backend is temporarily unavailable. */ }
}
document.querySelector('#disconnect-button').addEventListener('click', async () => {
  await fetch('/api/twitch/disconnect', { method: 'POST' });
  window.location.reload();
});
pollStatus();
window.setInterval(pollStatus, 2500);
