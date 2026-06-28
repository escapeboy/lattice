/**
 * Single-file control-plane dashboard. Served as static HTML; consumes the
 * server's REST + SSE endpoints. Surfaces every operator surface: live session
 * theater, consequential approvals, operator-write grants (shared-kernel mint),
 * human handoffs (with signed-page links), policy, and the replay browser.
 *
 * Auth: if the deployment sets a bearer token, paste it in the header field —
 * it is attached to every state-changing request (never stored as a cookie).
 *
 * Implementation note: this is a template literal, so the embedded client JS
 * uses string concatenation (no nested backticks/${}).
 */

export function buildUI(serverOrigin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lattice Control Plane</title>
<style>
  :root {
    --bg:#0b0e14; --panel:#131722; --panel-2:#0f131c; --border:#232838;
    --text:#e6e9ef; --muted:#8b93a7; --faint:#5b6373;
    --indigo:#6366f1; --blue:#3b82f6; --green:#34d399; --amber:#fbbf24; --red:#f87171; --violet:#a78bfa;
  }
  * , *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  body { font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  a { color:var(--blue); text-decoration:none; } a:hover { text-decoration:underline; }
  header { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:16px;
    padding:14px 22px; background:rgba(11,14,20,.85); backdrop-filter:blur(8px); border-bottom:1px solid var(--border); }
  .logo { font-size:17px; font-weight:650; letter-spacing:.01em; display:flex; align-items:center; gap:9px; }
  .logo .hex { color:var(--indigo); font-size:20px; }
  .spacer { flex:1; }
  .pill { display:inline-flex; align-items:center; gap:7px; font-size:12px; color:var(--muted);
    background:var(--panel); border:1px solid var(--border); border-radius:999px; padding:5px 11px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); transition:background .3s; }
  .dot.on { background:var(--green); box-shadow:0 0 8px var(--green); } .dot.off { background:var(--red); }
  .token-in { background:var(--panel-2); border:1px solid var(--border); color:var(--text);
    border-radius:8px; padding:6px 10px; font:inherit; font-size:12px; width:150px; }
  main { padding:22px; max-width:1500px; margin:0 auto; }
  .intent { display:flex; gap:10px; margin-bottom:20px; }
  .intent input { flex:1; background:var(--panel); border:1px solid var(--border); color:var(--text);
    padding:12px 14px; border-radius:11px; font:inherit; }
  .intent input:focus { outline:none; border-color:var(--indigo); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(380px,1fr)); gap:16px; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:0; overflow:hidden; }
  .panel.wide { grid-column:1/-1; }
  .phead { display:flex; align-items:center; gap:9px; padding:13px 16px; border-bottom:1px solid var(--border); }
  .phead h2 { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
  .phead .accent { width:7px; height:7px; border-radius:50%; }
  .a-blue{background:var(--blue)} .a-amber{background:var(--amber)} .a-indigo{background:var(--indigo)}
  .a-violet{background:var(--violet)} .a-green{background:var(--green)}
  .count { margin-left:auto; font-size:11px; font-weight:600; color:var(--bg); background:var(--amber);
    border-radius:999px; padding:1px 8px; min-width:20px; text-align:center; }
  .count.zero { background:var(--border); color:var(--faint); }
  .pbody { padding:12px 16px; max-height:360px; overflow:auto; }
  .empty { color:var(--faint); font-size:13px; padding:14px 2px; text-align:center; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--faint); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.05em; padding:0 8px 8px; }
  td { padding:8px; border-top:1px solid var(--border); vertical-align:middle; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .url { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); }
  .card { border:1px solid var(--border); border-radius:11px; padding:12px; margin-bottom:10px; background:var(--panel-2); }
  .card:last-child { margin-bottom:0; }
  .card .row1 { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .card .title { font-weight:600; }
  .card .sub { color:var(--muted); font-size:12px; word-break:break-all; }
  .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:6px; font-weight:500; }
  .b-amber{background:rgba(251,191,36,.14);color:var(--amber)} .b-green{background:rgba(52,211,153,.14);color:var(--green)}
  .b-red{background:rgba(248,113,113,.14);color:var(--red)} .b-violet{background:rgba(167,139,250,.14);color:var(--violet)}
  .b-blue{background:rgba(59,130,246,.14);color:var(--blue)}
  .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  button { font:inherit; font-size:13px; font-weight:500; border:0; border-radius:8px; padding:7px 14px; cursor:pointer; transition:opacity .15s, transform .05s; }
  button:hover { opacity:.88; } button:active { transform:translateY(1px); }
  .btn-pri { background:var(--indigo); color:#fff; }
  .btn-ok { background:rgba(52,211,153,.16); color:var(--green); }
  .btn-no { background:rgba(248,113,113,.16); color:var(--red); }
  .btn-ghost { background:var(--panel-2); color:var(--muted); border:1px solid var(--border); }
  .grant-token { margin-top:9px; font-family:ui-monospace,monospace; font-size:12px; background:#0a1020;
    border:1px solid var(--blue); border-radius:8px; padding:9px; color:var(--blue); word-break:break-all; cursor:pointer; }
  pre { background:var(--panel-2); border:1px solid var(--border); border-radius:9px; padding:11px; font-size:12px; overflow:auto; max-height:260px; color:var(--muted); }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font-size:13px; }
  .kv b { color:var(--muted); font-weight:500; }
  .live { color:var(--green); font-size:11px; }
  .toast { position:fixed; bottom:20px; right:20px; background:var(--panel); border:1px solid var(--border);
    border-left:3px solid var(--green); border-radius:10px; padding:12px 16px; font-size:13px; opacity:0; transform:translateY(8px); transition:.25s; pointer-events:none; }
  .toast.show { opacity:1; transform:translateY(0); }
  .flbl { display:block; font-size:11px; color:var(--muted); margin:10px 0 4px; }
  .fin { width:100%; background:var(--panel-2); border:1px solid var(--border); color:var(--text);
    border-radius:8px; padding:8px 10px; font:inherit; font-size:13px; }
  .fin:focus { outline:none; border-color:var(--indigo); }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="hex">⬡</span> Lattice Control Plane</div>
  <div class="spacer"></div>
  <input class="token-in" id="token" type="password" placeholder="bearer token (if set)" oninput="saveToken()">
  <div class="pill"><span class="dot" id="dot"></span><span id="status">connecting…</span></div>
</header>

<main>
  <div id="minted"></div>
  <div class="intent">
    <input id="intent-input" placeholder="Record an intent (autonomous dispatch not yet wired) — e.g. &quot;log into the staging dashboard and export the weekly report&quot;" onkeydown="if(event.key==='Enter')sendIntent()">
    <button class="btn-pri" onclick="sendIntent()">Record</button>
  </div>

  <div class="grid">
    <div class="panel wide">
      <div class="phead"><span class="accent a-blue"></span><h2>Live Sessions</h2><span class="live" id="sess-live"></span><span class="count zero" id="sess-count">0</span></div>
      <div class="pbody" id="sessions"><div class="empty">No active sessions</div></div>
    </div>

    <div class="panel">
      <div class="phead"><span class="accent a-amber"></span><h2>Approvals</h2><span class="count zero" id="appr-count">0</span></div>
      <div class="pbody" id="approvals"><div class="empty">No pending approvals</div></div>
    </div>

    <div class="panel">
      <div class="phead"><span class="accent a-indigo"></span><h2>Operator Grants</h2><span class="count zero" id="grant-count">0</span></div>
      <div class="pbody" id="grants"><div class="empty">No pending operator-write grants</div></div>
    </div>

    <div class="panel">
      <div class="phead"><span class="accent a-violet"></span><h2>Human Handoffs</h2><span class="count zero" id="ho-count">0</span></div>
      <div class="pbody" id="handoffs"><div class="empty">No pending handoffs</div></div>
    </div>

    <div class="panel">
      <div class="phead"><span class="accent a-green"></span><h2>Policy &amp; Settings</h2>
        <button class="btn-ghost" id="pol-edit" style="margin-left:auto;padding:3px 10px;font-size:11px" onclick="togglePolicyEdit()">Edit</button>
        <button class="btn-ghost" style="padding:3px 10px;font-size:11px" onclick="loadPolicy()">Refresh</button></div>
      <div class="pbody">
        <div class="kv" id="policy"><span class="empty">Loading…</span></div>
        <div id="policy-edit" style="display:none">
          <label class="flbl">Allowed origins (comma-separated)</label><input class="fin" id="f-origins" placeholder="https://app.example.com">
          <label class="flbl">Egress allowlist</label><input class="fin" id="f-egress" placeholder="https://api.example.com">
          <label class="flbl">Prohibited actions <span style="color:var(--faint)">(floor primitives always kept)</span></label><input class="fin" id="f-prohibited">
          <label class="flbl">Requires grant</label><input class="fin" id="f-grant">
          <label class="flbl">Budget limit (tokens)</label><input class="fin" id="f-budget" type="number" placeholder="0 = unlimited">
          <div class="actions"><button class="btn-pri" onclick="savePolicy()">Apply to live kernel</button>
            <button class="btn-ghost" onclick="togglePolicyEdit()">Cancel</button></div>
          <div style="margin-top:8px;font-size:11px;color:var(--faint)">Tainting stays on and egress-from-content stays blocked — the constitutional floor is not editable.</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="phead"><span class="accent a-violet"></span><h2>Persona Import · Chrome</h2></div>
      <div class="pbody">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Import cookies from a real Chrome profile into a persona so the agent operates already logged-in. macOS prompts your Keychain; values go to the encrypted vault — never to the model.</div>
        <label class="flbl">Persona ID</label><input class="fin" id="i-persona" placeholder="e.g. work-google">
        <label class="flbl">Origins to import (comma-separated)</label><input class="fin" id="i-origins" placeholder="https://mail.google.com, https://github.com">
        <label class="flbl">Chrome profile</label><input class="fin" id="i-profile" value="Default">
        <div class="actions"><button class="btn-pri" onclick="importPersona()">Import from Chrome</button></div>
        <div id="i-result" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>

    <div class="panel wide">
      <div class="phead"><span class="accent a-blue"></span><h2>Traces · Replay</h2></div>
      <div class="pbody" id="traces"><div class="empty">No traces recorded yet</div></div>
    </div>
  </div>
</main>
<div class="toast" id="toast"></div>

<script>
var API = '${serverOrigin}';
var sessions = [], approvals = [], grants = [], handoffs = [];

function tok() { return document.getElementById('token').value.trim(); }
function saveToken() { try { localStorage.setItem('lattice_cp_token', tok()); } catch(e){} }
function hdrs(json) { var h = {}; if (json) h['Content-Type']='application/json'; var t=tok(); if(t) h['Authorization']='Bearer '+t; return h; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function shrt(s,n){ s=String(s||''); return s.length>n? s.slice(0,n)+'…' : s; }
function toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){t.classList.remove('show');},2600); }
function setCount(id,n){ var e=document.getElementById(id); e.textContent=n; e.classList.toggle('zero', n===0); }

async function post(path, body){
  return fetch(API+path,{method:'POST',headers:hdrs(!!body),body:body?JSON.stringify(body):undefined});
}
async function get(path){ var r=await fetch(API+path).catch(function(){return null;}); return r&&r.ok? r.json():null; }

// ── Sessions theater ──────────────────────────────────────────────────────────
function renderSessions(){
  var el=document.getElementById('sessions'); setCount('sess-count', sessions.length);
  document.getElementById('sess-live').textContent = sessions.length? '● live':'';
  if(!sessions.length){ el.innerHTML='<div class="empty">No active sessions</div>'; return; }
  el.innerHTML='<table><tr><th>Session</th><th>URL</th><th>Nodes</th><th>Actions</th></tr>'+
    sessions.map(function(s){ return '<tr><td class="mono">'+esc(s.sessionId.slice(0,8))+'</td>'+
      '<td class="url">'+esc(s.url||'—')+'</td><td>'+(s.nodeCount==null?'—':s.nodeCount)+'</td>'+
      '<td><span class="badge b-blue">'+(s.actionCount||0)+'</span></td></tr>'; }).join('')+'</table>';
}

// ── Approvals (consequential) ─────────────────────────────────────────────────
function renderApprovals(){
  var el=document.getElementById('approvals'); setCount('appr-count', approvals.length);
  if(!approvals.length){ el.innerHTML='<div class="empty">No pending approvals</div>'; return; }
  el.innerHTML=approvals.map(function(a){ return '<div class="card"><div class="row1"><span class="title">'+esc(a.actionType)+
    '</span><span class="badge b-amber">'+esc(a.policyClass)+'</span></div><div class="sub">'+esc(a.origin)+'</div>'+
    '<div class="sub" style="margin-top:4px;color:var(--text)">'+esc(a.summary)+'</div><div class="actions">'+
    '<button class="btn-ok" onclick="approveAppr(\\''+a.id+'\\')">Approve</button>'+
    '<button class="btn-no" onclick="denyAppr(\\''+a.id+'\\')">Deny</button></div></div>'; }).join('');
}
async function approveAppr(id){ await post('/approvals/'+id+'/approve'); toast('Approved'); loadAll(); }
async function denyAppr(id){ await post('/approvals/'+id+'/deny',{reason:prompt('Reason for denial:')||'human denied'}); toast('Denied'); loadAll(); }

// ── Operator-write grants (shared-kernel mint) ────────────────────────────────
function renderGrants(){
  var el=document.getElementById('grants'); setCount('grant-count', grants.length);
  if(!grants.length){ el.innerHTML='<div class="empty">No pending operator-write grants</div>'; return; }
  el.innerHTML=grants.map(function(g){ return '<div class="card" id="g-'+g.id+'"><div class="row1">'+
    '<span class="title">'+esc(g.scope.tool)+'</span><span class="badge b-violet">operator write</span></div>'+
    '<div class="sub">'+esc(g.summary||'')+'</div><div class="actions">'+
    '<button class="btn-ok" onclick="approveGrant(\\''+g.id+'\\')">Approve &amp; mint token</button>'+
    '<button class="btn-no" onclick="denyGrant(\\''+g.id+'\\')">Deny</button></div></div>'; }).join('');
}
async function approveGrant(id){
  var r=await post('/operator-grants/'+id+'/approve'); var o=r&&r.ok? await r.json():null;
  if(o&&o.grant){ showMinted(o.grant); try{ navigator.clipboard.writeText(o.grant); toast('Grant approved — token copied to clipboard'); }catch(e){ toast('Grant approved'); } }
  loadGrants();
}
// A persistent banner for minted grant tokens (polling never wipes it).
function showMinted(token){
  var wrap=document.getElementById('minted');
  var el=document.createElement('div'); el.className='card'; el.style.borderColor='var(--blue)'; el.style.marginBottom='14px';
  el.innerHTML='<div class="row1"><span class="badge b-blue">grant minted</span>'+
    '<span class="sub" style="margin-left:auto">relay this single-use token to the agent</span></div>'+
    '<div class="grant-token" title="click to copy">'+esc(token)+'</div>';
  el.querySelector('.grant-token').onclick=function(){ navigator.clipboard.writeText(token); toast('Copied'); };
  var x=document.createElement('button'); x.className='btn-ghost'; x.textContent='Dismiss'; x.style.marginTop='8px';
  x.onclick=function(){ el.remove(); }; el.appendChild(x);
  wrap.prepend(el);
}
async function denyGrant(id){ await post('/operator-grants/'+id+'/deny',{reason:'denied'}); toast('Grant denied'); loadGrants(); }

// ── Handoffs ──────────────────────────────────────────────────────────────────
function renderHandoffs(){
  var el=document.getElementById('handoffs'); setCount('ho-count', handoffs.length);
  if(!handoffs.length){ el.innerHTML='<div class="empty">No pending handoffs</div>'; return; }
  el.innerHTML=handoffs.map(function(h){ var inp=h.type==='input';
    return '<div class="card"><div class="row1"><span class="title">'+esc(h.reason)+'</span>'+
    '<span class="badge '+(inp?'b-blue':'b-amber')+'">'+esc(h.type)+'</span>'+
    '<span class="badge '+(h.status==='claimed'?'b-green':'b-violet')+'">'+esc(h.status)+'</span></div>'+
    '<div class="sub">'+esc(h.origin)+'</div><div class="actions">'+
    (inp
      ? '<a href="'+API+'/handoff/'+h.id+'" target="_blank"><button class="btn-pri">Open secure form ↗</button></a>'
      : '<button class="btn-ok" onclick="resolveHo(\\''+h.id+'\\',true)">Approve</button>'+
        '<button class="btn-no" onclick="resolveHo(\\''+h.id+'\\',false)">Deny</button>')+
    '<a href="'+API+'/handoff/'+h.id+'" target="_blank"><button class="btn-ghost">Signed page ↗</button></a>'+
    '</div></div>'; }).join('');
}
async function resolveHo(id, ok){
  await post('/handoff/'+id+'/claim',{deviceId:'web'});
  await post('/handoff/'+id+'/approve',{deviceId:'web',approved:ok});
  toast(ok?'Handoff approved':'Handoff denied'); loadHandoffs();
}

// ── Policy ────────────────────────────────────────────────────────────────────
async function loadPolicy(){
  var p=await get('/policy'); if(!p) return; lastPolicy=p; var el=document.getElementById('policy');
  function arr(a){ return (a&&a.length)? a.map(esc).join(', ') : '<span style="color:var(--faint)">none</span>'; }
  el.innerHTML='<b>Allowed origins</b><span>'+arr(p.allowedOrigins)+'</span>'+
    '<b>Egress allowlist</b><span>'+arr(p.egressAllowlist)+'</span>'+
    '<b>Prohibited</b><span>'+arr(p.prohibitedActions)+'</span>'+
    '<b>Requires grant</b><span>'+arr(p.requireGrant)+'</span>'+
    '<b>Tainting</b><span><span class="badge b-green">on</span></span>'+
    '<b>Egress-from-content</b><span><span class="badge b-red">blocked</span></span>';
}

// ── Policy editing ────────────────────────────────────────────────────────────
var polEditing=false, lastPolicy=null;
function togglePolicyEdit(){
  polEditing=!polEditing;
  document.getElementById('policy').style.display=polEditing?'none':'grid';
  document.getElementById('policy-edit').style.display=polEditing?'block':'none';
  document.getElementById('pol-edit').textContent=polEditing?'View':'Edit';
  if(polEditing&&lastPolicy){
    var j=function(a){return (a||[]).join(', ');};
    document.getElementById('f-origins').value=j(lastPolicy.allowedOrigins);
    document.getElementById('f-egress').value=j(lastPolicy.egressAllowlist);
    document.getElementById('f-prohibited').value=j(lastPolicy.prohibitedActions);
    document.getElementById('f-grant').value=j(lastPolicy.requireGrant);
  }
}
function splitList(id){ return document.getElementById(id).value.split(',').map(function(s){return s.trim();}).filter(Boolean); }
async function savePolicy(){
  var patch={ allowedOrigins:splitList('f-origins'), egressAllowlist:splitList('f-egress'),
    prohibitedActions:splitList('f-prohibited'), requireGrant:splitList('f-grant') };
  var b=document.getElementById('f-budget').value; if(b!=='') patch.budgetLimit=Number(b);
  var r=await fetch(API+'/policy',{method:'PUT',headers:hdrs(true),body:JSON.stringify(patch)});
  if(r.ok){ toast('Policy applied to live kernel'); polEditing=true; togglePolicyEdit(); loadPolicy(); }
  else if(r.status===401){ toast('Unauthorized — enter the bearer token'); }
  else { toast('Apply failed'); }
}

// ── Persona import (Chrome) ───────────────────────────────────────────────────
async function importPersona(){
  var personaId=document.getElementById('i-persona').value.trim();
  var origins=splitList('i-origins'); var profile=document.getElementById('i-profile').value.trim()||'Default';
  var out=document.getElementById('i-result');
  if(!personaId||!origins.length){ out.innerHTML='<span style="color:var(--amber)">Persona ID and at least one origin are required.</span>'; return; }
  out.innerHTML='<span style="color:var(--muted)">Reading Chrome profile — approve the Keychain prompt…</span>';
  var r=await fetch(API+'/persona-import',{method:'POST',headers:hdrs(true),body:JSON.stringify({personaId,profile,origins})});
  if(r.status===401){ out.innerHTML='<span style="color:var(--amber)">Unauthorized — enter the bearer token.</span>'; return; }
  var d=await r.json().catch(function(){return null;});
  if(r.ok&&d){ out.innerHTML='<span style="color:var(--green)">Imported '+d.imported+' cookies into persona &ldquo;'+esc(personaId)+'&rdquo; — values went to the vault, never shown.</span>'; toast('Persona imported'); }
  else { out.innerHTML='<span style="color:var(--red)">'+esc(d&&d.error?d.error:'Import failed')+'</span>'; }
}

// ── Traces / replay ───────────────────────────────────────────────────────────
async function loadTraces(){
  var d=await get('/traces'); if(!d) return; var t=d.traces||[]; var el=document.getElementById('traces');
  if(!t.length){ el.innerHTML='<div class="empty">No traces recorded yet</div>'; return; }
  el.innerHTML='<table><tr><th>Trace</th><th>Session</th><th>Duration</th><th>Actions</th><th>Success</th><th></th></tr>'+
    t.map(function(x){ var ok=x.successRate===1; return '<tr><td class="mono">'+esc(x.traceId.slice(0,12))+'</td>'+
      '<td class="mono">'+esc(x.sessionId.slice(0,8))+'</td><td>'+x.durationMs+'ms</td><td>'+x.totalActions+'</td>'+
      '<td><span class="badge '+(ok?'b-green':'b-amber')+'">'+Math.round(x.successRate*100)+'%</span></td>'+
      '<td><a href="'+API+'/replay/'+encodeURIComponent(x.traceId)+'" target="_blank">replay ↗</a></td></tr>'; }).join('')+'</table>';
}

async function sendIntent(){
  var i=document.getElementById('intent-input'); var v=i.value.trim(); if(!v) return;
  var r=await post('/intent',{intent:v}); if(r&&r.ok){ i.value=''; toast('Intent recorded (dispatch not yet wired)'); }
}

// ── Loaders + SSE ─────────────────────────────────────────────────────────────
async function loadSessions(){ var d=await get('/sessions'); if(d){ sessions=d.sessions||[]; renderSessions(); } }
async function loadApprovals(){ var d=await get('/approvals'); if(d){ approvals=d.approvals||[]; renderApprovals(); } }
async function loadGrants(){ var d=await get('/operator-grants'); if(d){ grants=d.grants||[]; renderGrants(); } }
async function loadHandoffs(){ var d=await get('/handoffs'); if(d){ handoffs=d.handoffs||[]; renderHandoffs(); } }
function loadAll(){ loadSessions(); loadApprovals(); loadGrants(); loadHandoffs(); loadPolicy(); loadTraces(); }

function setConn(on){ var d=document.getElementById('dot'), s=document.getElementById('status');
  d.className='dot '+(on?'on':'off'); s.textContent=on?'connected':'reconnecting…'; }

function connectSSE(){
  var es=new EventSource(API+'/events');
  es.onopen=function(){ setConn(true); };
  es.onmessage=function(e){ try{ var m=JSON.parse(e.data);
    if(m.type==='sessions'){ sessions=m.data; renderSessions(); }
    else if(m.type==='approvals'){ approvals=m.data; renderApprovals(); }
    else if(m.type==='operator-grants'){ grants=m.data; renderGrants(); }
    else if(m.type==='handoffs'){ handoffs=m.data; renderHandoffs(); }
    else if(m.type==='policy'){ if(!polEditing) loadPolicy(); }
    else if(m.type==='trace'){ loadTraces(); }
  }catch(err){} };
  es.onerror=function(){ setConn(false); es.close(); setTimeout(connectSSE,3000); };
}

try { document.getElementById('token').value = localStorage.getItem('lattice_cp_token')||''; } catch(e){}
loadAll();
connectSSE();
setInterval(function(){ loadSessions(); loadGrants(); loadHandoffs(); loadTraces(); }, 5000);
</script>
</body>
</html>`;
}
