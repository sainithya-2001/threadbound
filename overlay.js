const STORAGE_KEY = 'raidbridge-approved-card-v1';
const stage = document.querySelector('#overlay-stage');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderEmpty(demoMode = false) {
  const heading = demoMode ? 'Demo preview' : 'Ready when you are.';
  const copy = demoMode ? 'Illustrative sample content only.<br/>No Twitch or AI services are connected.' : 'Your arrival card will appear here<br/>after the streamer approves it.';
  const footer = demoMode ? 'DEMO MODE · NOTHING LIVE IS CONNECTED' : 'Nothing shows without approval';
  stage.innerHTML = `<div class="overlay-empty"><div class="empty-mark"><span>⌁</span><i></i></div><div class="empty-label"><span class="empty-line"></span> THREADBOUND <span class="empty-line"></span></div><h1>${heading}</h1><p>${copy}</p><div class="empty-foot"><span class="empty-lock">◆</span> ${footer}</div></div>`;
}

function renderSample(demoMode = false) {
  let card;
  try { card = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { card = null; }
  if (!card || card.approved !== true || card.source !== 'sample' || typeof card.text !== 'string' || !card.text.trim()) return renderEmpty(demoMode);
  stage.innerHTML = `<article class="approved-overlay-card"><div class="approved-overlay-top"><span class="preview-brand"><span class="mini-wave">⌁</span> THREADBOUND</span><span class="approved-overlay-label"><i></i> STREAMER APPROVED</span></div><div class="approved-overlay-content"><div class="approved-overlay-meta"><span class="preview-live-dot"></span> RAID ARRIVAL <span class="preview-sep">·</span> ${demoMode ? 'DEMO MODE · SAMPLE DATA' : 'SAMPLE DATA'}</div><p>${escapeHtml(card.text).replace(/\n/g, '<br>')}</p></div><div class="approved-overlay-bottom"><span><b>✳</b> A little context goes a long way.</span><span class="overlay-brand-end">THREADBOUND</span></div></article>`;
}

function renderApproved(card) {
  if (!card || card.approved !== true || typeof card.text !== 'string' || !card.text.trim()) return renderEmpty();
  const facts = card.raidFacts || {};
  const detail = [facts.sourceChannel, Number.isInteger(facts.viewerCount) ? `${facts.viewerCount.toLocaleString()} viewers` : null].filter(Boolean).join(' · ');
  stage.innerHTML = `<article class="approved-overlay-card"><div class="approved-overlay-top"><span class="preview-brand"><span class="mini-wave">⌁</span> THREADBOUND</span><span class="approved-overlay-label"><i></i> STREAMER APPROVED</span></div><div class="approved-overlay-content">${detail ? `<div class="live-overlay-verified">✓ VERIFIED RAID · ${escapeHtml(detail)}<small>Event information from Twitch EventSub</small></div>` : ''}<div class="approved-overlay-meta"><span class="preview-live-dot"></span> AI-GENERATED CONVERSATION BRIDGE</div><p class="approved-live-text">${escapeHtml(card.text).replace(/\n/g, '<br>')}</p></div><div class="approved-overlay-bottom"><span><b>✳</b> A little context goes a long way.</span><span class="overlay-brand-end">THREADBOUND</span></div></article>`;
}

// Start blank; the server must confirm whether this is live mode and return an
// approved card before any connected-channel content is rendered.
let connected = true;
renderEmpty();

async function syncConnection() {
  try {
    const response = await fetch('/api/twitch/status', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (state.demoMode === true) {
      connected = false;
      renderSample(true);
      return;
    }
    const next = Boolean(state.connected);
    if (next) {
      connected = true;
      const approvedResponse = await fetch('/api/context/approved', { cache: 'no-store' });
      if (!approvedResponse.ok) return renderEmpty();
      renderApproved(await approvedResponse.json());
      return;
    }
    connected = false;
    renderSample();
  } catch { /* On network errors, keep the safe current frame. */ }
}

syncConnection();
window.setInterval(syncConnection, 2500);
window.addEventListener('storage', event => {
  if (!connected && (event.key === STORAGE_KEY || event.key === null)) renderSample();
});
