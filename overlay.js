const STORAGE_KEY = 'raidbridge-approved-card-v1';
const stage = document.querySelector('#overlay-stage');

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function render({ connected = false } = {}) {
  if (connected) {
    stage.innerHTML = '<div class="overlay-empty"><div class="empty-mark"><span>⌁</span><i></i></div><div class="empty-label"><span class="empty-line"></span> THREADBOUND <span class="empty-line"></span></div><h1>Ready when you are.</h1><p>An arrival card will appear here<br/>after the streamer approves it.</p><div class="empty-foot"><span class="empty-lock">◆</span> Nothing shows without approval</div></div>';
    return;
  }
  let card;
  try { card = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { card = null; }
  if (!card || card.approved !== true || typeof card.text !== 'string' || !card.text.trim()) {
    stage.innerHTML = '<div class="overlay-empty"><div class="empty-mark"><span>⌁</span><i></i></div><div class="empty-label"><span class="empty-line"></span> THREADBOUND <span class="empty-line"></span></div><h1>Ready when you are.</h1><p>Your arrival card will appear here<br/>after the streamer approves it.</p><div class="empty-foot"><span class="empty-lock">◆</span> Nothing shows without approval</div></div>';
    return;
  }
  stage.innerHTML = `<article class="approved-overlay-card"><div class="approved-overlay-top"><span class="preview-brand"><span class="mini-wave">⌁</span> THREADBOUND</span><span class="approved-overlay-label"><i></i> STREAMER APPROVED</span></div><div class="approved-overlay-content"><div class="approved-overlay-meta"><span class="preview-live-dot"></span> RAID ARRIVAL <span class="preview-sep">·</span> SAMPLE DATA</div><p>${escapeHtml(card.text).replace(/\n/g, '<br>')}</p></div><div class="approved-overlay-bottom"><span><b>✳</b> A little context goes a long way.</span><span class="overlay-brand-end">THREADBOUND</span></div></article>`;
}

// Start in the safe empty state. A persisted sample/demo card is shown only after
// the server confirms that Twitch is not connected.
let connected = true;
render({ connected });
async function syncConnection() {
  try {
    const response = await fetch('/api/twitch/status', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    const next = Boolean(state.connected);
    if (connected !== next) { connected = next; render({ connected }); }
  } catch { /* The approved sample remains available if the local server is temporarily offline. */ }
}
render();
syncConnection();
window.setInterval(syncConnection, 2500);
window.addEventListener('storage', event => { if (event.key === STORAGE_KEY || event.key === null) render({ connected }); });
