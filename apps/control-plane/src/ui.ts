/**
 * Minimal single-file HTML control plane UI.
 * Served as static HTML; connects to the server's SSE stream for live updates.
 */

export function buildUI(serverOrigin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lattice Control Plane</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: #0d0d0d; color: #e0e0e0; padding: 1rem; }
  h1 { color: #7ee8a2; margin-bottom: 1rem; font-size: 1.4rem; }
  h2 { color: #7ec8e3; font-size: 1rem; margin: 1.2rem 0 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .panel { background: #161616; border: 1px solid #333; border-radius: 4px; padding: 1rem; }
  .panel.full { grid-column: span 2; }
  .badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; }
  .badge-green { background: #1a4d2e; color: #7ee8a2; }
  .badge-yellow { background: #4d3a00; color: #f0c040; }
  .badge-red { background: #4d0000; color: #ff6b6b; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  td, th { padding: 0.3rem 0.5rem; border-bottom: 1px solid #222; text-align: left; }
  th { color: #888; font-weight: normal; }
  button { padding: 0.3rem 0.8rem; border: none; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 0.8rem; }
  .btn-approve { background: #1a4d2e; color: #7ee8a2; }
  .btn-deny { background: #4d0000; color: #ff6b6b; }
  button:hover { opacity: 0.8; }
  .intent-form { display: flex; gap: 0.5rem; }
  .intent-form input { flex: 1; background: #222; border: 1px solid #444; color: #e0e0e0; padding: 0.4rem; border-radius: 3px; font-family: inherit; }
  .intent-form button { background: #2d4a7a; color: #7ec8e3; }
  pre { background: #111; padding: 0.8rem; border-radius: 3px; font-size: 0.8rem; overflow: auto; max-height: 200px; }
  #status { font-size: 0.75rem; color: #666; margin-bottom: 0.5rem; }
  .empty { color: #555; font-size: 0.85rem; padding: 0.5rem 0; }
</style>
</head>
<body>
<h1>⬡ Lattice Control Plane</h1>
<div id="status">Connecting…</div>

<div class="grid">
  <!-- Intent input -->
  <div class="panel">
    <h2>Intent</h2>
    <div class="intent-form">
      <input type="text" id="intent-input" placeholder="e.g. fill the login form with test credentials">
      <button onclick="sendIntent()">Send</button>
    </div>
  </div>

  <!-- Policy -->
  <div class="panel">
    <h2>Policy</h2>
    <div id="policy-view"><span class="empty">Loading…</span></div>
    <button style="margin-top:0.5rem;background:#333;color:#ccc" onclick="loadPolicy()">Refresh</button>
  </div>

  <!-- Sessions theater -->
  <div class="panel">
    <h2>Sessions</h2>
    <div id="sessions-view"><span class="empty">No active sessions</span></div>
  </div>

  <!-- Approval inbox -->
  <div class="panel">
    <h2>Approvals <span id="approval-count" class="badge badge-yellow" style="display:none"></span></h2>
    <div id="approvals-view"><span class="empty">No pending approvals</span></div>
  </div>

  <!-- Replay browser -->
  <div class="panel full">
    <h2>Recent Traces</h2>
    <div id="traces-view"><span class="empty">No traces recorded yet</span></div>
  </div>
</div>

<script>
const API = '${serverOrigin}';
let approvals = [];
let sessions = [];

async function loadSessions() {
  const r = await fetch(API + '/sessions').catch(() => null);
  if (!r?.ok) return;
  const data = await r.json();
  sessions = data.sessions ?? [];
  renderSessions();
}

async function loadApprovals() {
  const r = await fetch(API + '/approvals').catch(() => null);
  if (!r?.ok) return;
  const data = await r.json();
  approvals = data.approvals ?? [];
  renderApprovals();
}

async function loadPolicy() {
  const r = await fetch(API + '/policy').catch(() => null);
  if (!r?.ok) return;
  const data = await r.json();
  document.getElementById('policy-view').innerHTML =
    '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
}

async function loadTraces() {
  const r = await fetch(API + '/traces').catch(() => null);
  if (!r?.ok) return;
  const data = await r.json();
  const traces = data.traces ?? [];
  if (!traces.length) return;
  const el = document.getElementById('traces-view');
  el.innerHTML = '<table><tr><th>Trace ID</th><th>Session</th><th>Duration</th><th>Actions</th><th>Success</th></tr>' +
    traces.map(t => '<tr><td>' + t.traceId.slice(0,12) + '…</td><td>' + t.sessionId.slice(0,8) + '…</td>' +
      '<td>' + t.durationMs + 'ms</td><td>' + t.totalActions + '</td>' +
      '<td><span class="badge ' + (t.successRate === 1 ? 'badge-green' : 'badge-yellow') + '">' +
      (t.successRate * 100).toFixed(0) + '%</span></td></tr>').join('') + '</table>';
}

function renderSessions() {
  const el = document.getElementById('sessions-view');
  if (!sessions.length) { el.innerHTML = '<span class="empty">No active sessions</span>'; return; }
  el.innerHTML = '<table><tr><th>Session</th><th>URL</th><th>Nodes</th><th>Actions</th></tr>' +
    sessions.map(s =>
      '<tr><td>' + s.sessionId.slice(0,8) + '…</td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">' + (s.url||'—') + '</td>' +
      '<td>' + (s.nodeCount ?? '—') + '</td>' +
      '<td>' + s.actionCount + '</td></tr>'
    ).join('') + '</table>';
}

function renderApprovals() {
  const el = document.getElementById('approvals-view');
  const badge = document.getElementById('approval-count');
  if (!approvals.length) {
    el.innerHTML = '<span class="empty">No pending approvals</span>';
    badge.style.display = 'none'; return;
  }
  badge.style.display = 'inline-block';
  badge.textContent = approvals.length;
  el.innerHTML = approvals.map(a =>
    '<div style="border:1px solid #333;padding:0.5rem;margin-bottom:0.4rem;border-radius:3px">' +
    '<div><strong>' + a.actionType + '</strong> <span class="badge badge-yellow">' + a.policyClass + '</span></div>' +
    '<div style="font-size:0.8rem;color:#888">' + a.origin + '</div>' +
    '<div style="font-size:0.8rem;margin-top:0.3rem">' + a.summary + '</div>' +
    '<div style="margin-top:0.4rem">' +
    '<button class="btn-approve" onclick="approve(\\'' + a.id + '\\')">✓ Approve</button> ' +
    '<button class="btn-deny" onclick="deny(\\'' + a.id + '\\')">✗ Deny</button>' +
    '</div></div>'
  ).join('');
}

async function approve(id) {
  await fetch(API + '/approvals/' + id + '/approve', { method: 'POST' });
  await loadApprovals();
}

async function deny(id) {
  const reason = prompt('Reason for denial:') || 'human denied';
  await fetch(API + '/approvals/' + id + '/deny', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  await loadApprovals();
}

async function sendIntent() {
  const input = document.getElementById('intent-input');
  const intent = input.value.trim();
  if (!intent) return;
  const r = await fetch(API + '/intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent }),
  }).catch(() => null);
  if (r?.ok) { input.value = ''; alert('Intent queued: ' + intent); }
}

// SSE live updates
function connectSSE() {
  const es = new EventSource(API + '/events');
  es.onopen = () => { document.getElementById('status').textContent = 'Connected'; };
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sessions') { sessions = msg.data; renderSessions(); }
      if (msg.type === 'approvals') { approvals = msg.data; renderApprovals(); }
      if (msg.type === 'trace') { loadTraces(); }
    } catch {}
  };
  es.onerror = () => {
    document.getElementById('status').textContent = 'Disconnected — reconnecting…';
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// Init
Promise.all([loadSessions(), loadApprovals(), loadPolicy(), loadTraces()]);
connectSSE();
setInterval(() => { loadSessions(); loadTraces(); }, 5000);
</script>
</body>
</html>`;
}
