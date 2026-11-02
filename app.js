const textarea = document.querySelector('#card-edit');
const count = document.querySelector('#char-count');
const approve = document.querySelector('#approve-button');
const dismiss = document.querySelector('#dismiss-button');
const toast = document.querySelector('#toast');
const STORAGE_KEY = 'raidbridge-approved-card-v1';
let liveConnected = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('visible'), 2800);
}
function updateCount() { count.textContent = `${textarea.value.length} / 320`; }
textarea.addEventListener('input', updateCount);
updateCount();

approve.addEventListener('click', () => {
  if (liveConnected) { showToast('Live raid cards arrive in the next milestone. Sample cards are paused while Twitch is connected.'); return; }
  const text = textarea.value.trim();
  if (!text) { showToast('Add context to the card before approving it.'); return; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, source: 'sample', approved: true, approvedAt: Date.now() }));
  approve.innerHTML = '<span>✓</span> Approved for OBS';
  approve.classList.add('approved');
  document.querySelector('.review-status').innerHTML = '<span class="approved-dot"></span> APPROVED';
  document.querySelector('.draft-note').innerHTML = '<span class="lock-icon">✓</span><span>Your approved card is now visible in the OBS overlay.</span>';
  document.querySelector('.overlay-status-card strong').textContent = 'OBS overlay is live';
  document.querySelector('.overlay-status-card span:not(.overlay-status-icon)').textContent = 'Your approved card is being shown in the scene.';
  showToast('Approved. Your card is now visible in OBS.');
});

dismiss.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  approve.innerHTML = '<span>✓</span> Approve for OBS';
  approve.classList.remove('approved');
  document.querySelector('.review-status').innerHTML = '<span></span> NEEDS APPROVAL';
  document.querySelector('.draft-note').innerHTML = '<span class="lock-icon">⌑</span><span>This is a private draft. It won\'t appear on stream until you approve it.</span>';
  document.querySelector('.overlay-status-card strong').textContent = 'OBS overlay is waiting';
  document.querySelector('.overlay-status-card span:not(.overlay-status-icon)').textContent = 'Approve this draft to preview it in your scene.';
  showToast('Draft dismissed. The OBS overlay is clear.');
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
  list.innerHTML = raids.map(raid => `<div class="live-raid-event"><div class="live-event-avatar">${escapeHtml((raid.fromBroadcasterName || '?').slice(0, 1).toUpperCase())}</div><div class="live-event-copy"><strong>${escapeHtml(raid.fromBroadcasterName || raid.fromBroadcasterLogin || 'Unknown channel')} <span>raided</span></strong><small>${escapeHtml(raid.viewers)} viewers → ${escapeHtml(raid.toBroadcasterName || raid.toBroadcasterLogin || 'your channel')}</small></div><time>${escapeHtml(formatTime(raid.receivedAt))}</time><span class="verified-event">✓ TWITCH EVENT</span></div>`).join('');
}
function renderConnection(state) {
  const connectionName = document.querySelector('#connection-name');
  const connectionDetail = document.querySelector('#connection-detail');
  const livePill = document.querySelector('#mode-pill');
  const connect = document.querySelector('#twitch-connect');
  const list = document.querySelector('#live-raid-list');
  const sampleBanner = document.querySelector('#sample-banner');
  const live = Boolean(state.connected && state.broadcaster);
  const wasLive = liveConnected;
  liveConnected = live;
  if (!state.configured && !live) {
    document.querySelector('#integration-health').hidden = true;
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
    ? 'Raid events and bounded chat capture are real Twitch data. No AI summary is generated yet; sample conversation content stays out of live context.'
    : 'Raid events below are real Twitch data. Chat capture waits for its Twitch permission; the conversation sample stays labeled and is not live context.';
  document.querySelector('#sample-banner-tag').textContent = state.chat?.collectionActive ? 'LIVE CHAT' : 'CHAT PERMISSION';
  document.querySelectorAll('.sample-only').forEach(el => { el.hidden = true; });
  document.querySelectorAll('.sample-raid-only').forEach(el => { el.hidden = true; });
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
