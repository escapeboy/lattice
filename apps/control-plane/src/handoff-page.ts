/**
 * The human-facing handoff page (PWA-style). Rendered only after the server has
 * verified the request signature — so a phishing push to a look-alike URL can't
 * produce this form. For a Type B (input) handoff the value is POSTed straight
 * to the control plane, which writes it Vault→form; it never returns in a body.
 */

import type { HandoffView } from "./types.js";

export function buildHandoffPage(h: HandoffView): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const body =
    h.type === "approval"
      ? `<p class="reason">${esc(h.reason)}</p>
         <p class="origin">${esc(h.origin)}</p>
         <div class="row">
           <button class="approve" onclick="resolve(true)">Approve</button>
           <button class="deny" onclick="resolve(false)">Deny</button>
         </div>
         <script>
           async function resolve(ok) {
             await fetch(location.pathname + '/claim', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:'web'})});
             await fetch(location.pathname + '/approve', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:'web',approved:ok})});
             document.getElementById('status').textContent = ok ? 'Approved ✓' : 'Denied ✗';
             document.querySelector('.row').style.display='none';
           }
         </script>`
      : `<p class="reason">${esc(h.reason)}</p>
         <p class="origin">${esc(h.origin)}</p>
         <label>${esc(h.field ?? "value")}</label>
         <input id="val" type="password" autocomplete="one-time-code" />
         <input id="node" placeholder="field node id" />
         <input id="sid" placeholder="session id" />
         <button class="approve" onclick="submitInput()">Send to form</button>
         <script>
           async function submitInput() {
             await fetch(location.pathname + '/claim', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:'web'})});
             const r = await fetch(location.pathname + '/input', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
               deviceId:'web', sessionId:document.getElementById('sid').value, fieldNodeId:document.getElementById('node').value, value:document.getElementById('val').value
             })});
             document.getElementById('val').value='';
             document.getElementById('status').textContent = (await r.json()).filled ? 'Filled ✓' : 'Failed';
           }
         </script>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lattice handoff</title>
<style>
  body{font:16px system-ui;margin:0;background:#0f1115;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:28px;max-width:380px;width:90%}
  h1{font-size:18px;margin:0 0 4px}.tag{font-size:12px;color:#8b93a7;text-transform:uppercase;letter-spacing:.05em}
  .reason{font-size:17px;margin:14px 0 2px}.origin{color:#8b93a7;font-size:13px;margin:0 0 18px;word-break:break-all}
  .row{display:flex;gap:10px}button{flex:1;padding:12px;border:0;border-radius:10px;font-size:15px;cursor:pointer}
  .approve{background:#2563eb;color:#fff}.deny{background:#3a3f4b;color:#e6e6e6}
  label{display:block;font-size:13px;color:#8b93a7;margin:8px 0 4px}
  input{width:100%;box-sizing:border-box;padding:10px;margin-bottom:8px;border-radius:8px;border:1px solid #2a2f3a;background:#0f1115;color:#e6e6e6}
  #status{margin-top:14px;color:#34d399;font-weight:600}
</style></head><body>
  <div class="card">
    <div class="tag">Lattice · ${esc(h.type)} handoff · verified</div>
    <h1>Human intervention requested</h1>
    ${body}
    <div id="status"></div>
  </div>
</body></html>`;
}
