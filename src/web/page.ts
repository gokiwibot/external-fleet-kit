/** The dashboard page: four tables fed by `/events`. Plain HTML and ~120 lines of script, on purpose (design §8). */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>efk dashboard</title>
<style>
body{font:13px/1.4 ui-monospace,Menlo,monospace;margin:16px;color:#222;background:#fafafa}
h1{font-size:15px;margin:0 0 12px}nav button{margin-right:6px}section{display:none}section.on{display:block}
table{border-collapse:collapse;width:100%}td,th{padding:3px 8px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}
.up,.ok{color:#1a7f37}.down,.bad{color:#c62828}.warn{color:#b26a00}.dim{color:#888}
</style></head><body>
<div id="demo" hidden style="background:#c62828;color:#fff;padding:6px 10px;margin:-8px 0 12px;font-weight:700">DEMO MODE — not connected to remi. Everything below is invented by the kit.</div>
<h1>efk · <span id="ns">?</span> · <span id="count">0</span> bots</h1>
<nav><button data-s="bots">BOTS</button><button data-s="commands">COMMANDS</button><button data-s="events">EVENTS</button><button data-s="log">LOG</button></nav>
<section id="bots" class="on"><table><thead><tr><th>bot</th><th>link</th><th>avail</th><th>batt</th><th>door</th><th>command</th><th>age</th><th>seq</th><th>drops</th></tr></thead><tbody></tbody></table></section>
<section id="commands"><table><thead><tr><th>last</th><th>bot</th><th>type</th><th>id</th><th>sends</th><th>outcome</th><th>echo</th></tr></thead><tbody></tbody></table></section>
<section id="events"><table><thead><tr><th>at</th><th>bot</th><th>type</th><th>delivered</th><th>detail</th></tr></thead><tbody></tbody></table></section>
<section id="log"><table><thead><tr><th>at</th><th>level</th><th>message</th></tr></thead><tbody></tbody></table></section>
<script>
const t = (ms) => new Date(ms).toISOString().slice(11, 19)
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const rows = (id, html) => { document.querySelector('#' + id + ' tbody').innerHTML = html }
function render(s) {
  document.getElementById('ns').textContent = s.namespace ?? '?'
  document.getElementById('count').textContent = s.bots.length
  if (s.demo) document.getElementById('demo').hidden = false
  rows('bots', s.bots.map((b) => '<tr><td>' + esc(b.botId) + '</td><td class="' + (b.connected ? 'up' : 'down') + '">' + (b.connected ? 'up' : 'down') + '</td><td>' + (b.available ? 'yes' : 'no') + '</td><td class="' + (b.batteryPercentage < 20 ? 'bad' : '') + '">' + b.batteryPercentage + '%</td><td>' + esc(b.door) + '</td><td>' + esc(b.command) + '</td><td class="dim">' + (b.lastPublishedAgeMs == null ? 'never' : Math.round(b.lastPublishedAgeMs / 1000) + 's') + '</td><td class="dim">' + (b.seq ?? '—') + '</td><td class="' + (b.dropped > 0 ? 'bad' : 'dim') + '">' + b.dropped + '</td></tr>').join(''))
  rows('commands', s.commands.map((c) => '<tr><td class="dim">' + t(c.lastAt) + '</td><td>' + esc(c.botId) + '</td><td>' + esc(c.type) + '</td><td>' + esc(c.commandId) + '</td><td class="' + (c.sends > 1 ? 'warn' : '') + '">×' + c.sends + '</td><td class="' + (/^(4|5|rejected|no response)/.test(c.outcome) ? 'bad' : c.outcome === 'pending' ? 'dim' : 'ok') + '">' + esc(c.outcome) + '</td><td class="dim">' + (c.echoLatencyMs == null ? '—' : c.echoLatencyMs + ' ms') + '</td></tr>').join(''))
  rows('events', s.events.map((e) => '<tr><td class="dim">' + t(e.at) + '</td><td>' + esc(e.botId) + '</td><td>' + esc(e.type) + '</td><td class="' + (e.delivered ? 'ok' : 'bad') + '">' + (e.delivered ? 'delivered' : 'not delivered') + '</td><td class="dim">' + esc(e.detail) + '</td></tr>').join(''))
  rows('log', s.log.map((l) => '<tr><td class="dim">' + t(l.at) + '</td><td class="' + (l.dropped || l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : 'dim') + '">' + l.level + '</td><td class="' + (l.dropped ? 'bad' : '') + '">' + esc(l.message) + '</td></tr>').join(''))
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === b.dataset.s))
}))
fetch('/api/snapshot').then((r) => r.json()).then(render)
const es = new EventSource('/events')
es.addEventListener('snapshot', (e) => render(JSON.parse(e.data)))
es.onerror = () => { document.querySelector('h1').classList.add('bad') }
</script></body></html>`
