/**
 * The dashboard page: four views fed by `/events`, redesigned to match remi-pro's own docs pages
 * (`/docs/delivery-api`) so the kit looks like the product it integrates with — plus the manual
 * fault controls Task A exposed (BOTS view only: click a row, then a control bar drives available/
 * door/link/blocked for that bot). Plain HTML, plain CSS, one vanilla `<script>` (design §8): no UI
 * framework, no build step, no front-end dependency. The palette below is lifted from the docs pages
 * verbatim, including their two deliberate quirks: no green anywhere (a healthy state is the `GET`
 * badge cyan), and the LOG view alone sits on the docs' dark code surface, because it is the one view
 * that is meant to read as a terminal.
 *
 * Font: the docs pages load Inter from Google Fonts, but this page did not load any webfont before
 * this change, so pulling one in now would be a new network dependency in a tool partners run
 * offline. We keep it offline: a system UI stack for prose, and the same system monospace stack the
 * old page already used for everything else. Metrics differ slightly from Inter; the type scale below
 * was chosen to read the same regardless.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>efk dashboard</title>
<style>
:root{
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  --ink:#262626;--body:#3f3f3c;--muted:#8e8d8a;--code:#5b6470;
  --cyan-bg:#5dd7f5;--cyan-fg:#0d2a31;
  --amber-bg:#f2b84b;--amber-fg:#3a2700;
  --red-bg:#be4747;--red-fg:#ffffff;
  --neutral-bg:#f2f1ee;
  --border:#ecebea;--border2:#e4e2df;--panel:#f8f6f3;
  --log-bg:#262626;--log-border:#3a3835;--log-text:#e9e7e3;--log-warn:#f2b84b;--log-error:#ff8f8f;
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--sans);color:var(--body);background:#ffffff;-webkit-font-smoothing:antialiased}
code,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.ink{color:var(--ink)}
.strong{font-weight:600}
.muted{color:var(--muted)}
.code-color{color:var(--code)}
.bad-text{color:var(--red-bg)}
.amber-text{color:var(--amber-fg)}
.chip{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
.chip-cyan{background:var(--cyan-bg);color:var(--cyan-fg)}
.chip-amber{background:var(--amber-bg);color:var(--amber-fg)}
.chip-red{background:var(--red-bg);color:var(--red-fg)}
.chip-neutral{background:var(--neutral-bg);color:var(--muted)}

#demoBanner{background:var(--red-bg);color:#fff}
#demoBanner .inner{max-width:1320px;margin:0 auto;display:flex;align-items:center;gap:11px;padding:10px 32px;font-size:13px;font-weight:500}

.topbar{border-bottom:1px solid var(--border);background:#fff}
.topbar-inner{max-width:1320px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 32px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px}
.brand-mark{width:18px;height:18px;background:var(--ink);border-radius:5px;flex-shrink:0}
.brand-text{border-left:1px solid var(--border);padding-left:10px;font-weight:500;color:var(--muted);font-size:13px}
.contract-pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--ink);border-radius:999px;padding:6px 15px;font-size:13px;font-weight:500;color:var(--ink)}

.shell{max-width:1320px;margin:0 auto;padding:0 32px}
.masthead{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:22px 0 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
h1{margin:0;font-size:32px;font-weight:600;letter-spacing:-0.03em;line-height:.95;color:var(--ink)}
.tags{margin-top:13px;display:flex;gap:8px;flex-wrap:wrap}
.tag{display:inline-flex;align-items:center;gap:9px;border:1px solid var(--border);background:var(--panel);border-radius:999px;padding:6px 14px}
.tag code{font-size:13px;color:var(--ink)}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{border:1px solid var(--border);border-radius:14px;padding:12px 17px;min-width:116px}
.stat .statval{margin-top:6px;font-size:23px;font-weight:600;letter-spacing:-0.02em;color:var(--ink)}
.stat .statval.bad{color:var(--red-bg)}
.statof{color:var(--muted);font-size:14px;font-weight:500}
.feed{min-width:138px}
.feed.down{border-color:#e8c9c9;background:#fdf6f6}
.feedrow{margin-top:6px;display:flex;align-items:center;gap:8px}
.feedrow .mono{font-size:13px;color:var(--code)}

.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.tabs button{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;padding:13px 16px;margin-bottom:-1px;border-bottom:2px solid transparent;color:#5b5b58;font-size:13.5px;font-family:var(--sans)}
.tabs button.on{border-bottom-color:var(--ink);color:var(--ink);font-weight:600}
.tabs button .count{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--muted);background:var(--neutral-bg);border-radius:999px;padding:2px 8px}
.tabs button.on .count{color:#fff;background:var(--ink)}

.tablewrap{padding:18px 0 0;overflow-x:auto}
.tbl{overflow:hidden;border-radius:14px;border:1px solid var(--border2);min-width:640px}
.thead,.trow{display:grid;align-items:center}
.thead{background:var(--neutral-bg)}
.thead>div{padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.trow{border-top:1px solid var(--border);background:#fff}
.trow>div{padding:12px 16px;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trow.pick{cursor:pointer}
.trow.pick:hover{background:var(--panel)}
.trow.sel{background:var(--panel);box-shadow:inset 2px 0 0 0 var(--ink)}
.trow .body-cell{font-family:var(--sans);font-size:13.5px;color:var(--body);white-space:normal}

.logcard{overflow:hidden;border-radius:14px;border:1px solid var(--log-border);background:var(--log-bg);padding:6px 0;min-width:520px}
.logrow{display:grid;grid-template-columns:90px 74px 1fr;align-items:baseline;gap:12px;padding:7px 20px;font-size:12.5px;line-height:1.6;font-family:var(--mono)}
.logrow .at{color:var(--muted)}
.logrow .lvl{font-weight:500}

.controlbar{flex-shrink:0;margin:16px 0 20px;border:1px solid var(--border2);border-radius:14px;background:var(--panel);padding:15px 18px}
.controlbar .row{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.controlbar .selected{display:flex;align-items:baseline;gap:10px;min-width:190px}
.controlbar .selected code{font-size:14px;font-weight:600;color:var(--ink)}
.controlbar .pills{display:flex;gap:8px;flex-wrap:wrap}
.pill{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:9px;border-radius:999px;padding:7px 14px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--sans)}
.pill .key{font-family:var(--mono);font-size:10px;font-weight:600;border-radius:4px;padding:1px 5px}
.pill.on{border:1px solid var(--ink);background:var(--ink);color:#fff}
.pill.on .key{border:1px solid rgba(255,255,255,.45);color:rgba(255,255,255,.8)}
.pill.off{border:1px solid #c9c6c2;background:#fff;color:var(--ink)}
.pill.off .key{border:1px solid var(--border2);color:var(--muted)}
.pill.disabled{border:1px solid var(--border2);background:var(--neutral-bg);color:var(--muted);cursor:not-allowed;opacity:.72}
.pill.disabled .key{border:1px solid #ddd9d4;color:#b8b4ae}
.controlbar .noterow{margin-top:13px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:flex-start;gap:9px;min-height:19px}
.controlbar .noterow .note-icon{flex-shrink:0;margin-top:1px}
.controlbar .noterow .note-text{font-family:var(--mono);font-size:12.5px;line-height:1.5}
.controlbar .noterow .hint{font-size:12.5px;color:var(--muted)}
.controlbar .off-reason{font-size:12.5px;color:var(--muted)}
</style></head><body>
<div id="demoBanner" hidden><div class="inner">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
<span>Demo mode — not connected to remi. Everything below is invented by the kit.</span>
</div></div>
<div class="topbar"><div class="topbar-inner">
<div class="brand"><span class="brand-mark"></span><span class="brand-text"><strong style="color:#262626;font-weight:600">EFK</strong> — Robot.com External Fleet Kit</span></div>
<div class="contract-pill"><span>External Fleets contract</span>
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>
</div>
</div></div>
<main class="shell">
  <div class="masthead">
    <div>
      <h1 id="ns">?</h1>
      <div class="tags">
        <div class="tag"><span class="label">Transport</span><code>http</code></div>
        <div class="tag"><span class="label">Dashboard</span><code id="dashAddr">?</code></div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="label">Bots online</div><div class="mono statval" id="statOnline">0<span class="statof" id="statOf">/0</span></div></div>
      <div class="stat"><div class="label">States dropped</div><div class="mono statval" id="statDrops">0</div></div>
      <div class="stat feed" id="feedStat"><div class="label" id="feedLabel">Updated</div><div class="feedrow"><span class="chip chip-cyan" id="feedChip">live</span><span class="mono" id="feedTime">—</span></div></div>
    </div>
  </div>
  <nav class="tabs" id="tabs">
    <button data-tab="bots" class="on">Bots<span class="count" id="cnt-bots">0</span></button>
    <button data-tab="commands">Commands<span class="count" id="cnt-commands">0</span></button>
    <button data-tab="events">Events<span class="count" id="cnt-events">0</span></button>
    <button data-tab="log">Log<span class="count" id="cnt-log">0</span></button>
  </nav>
  <div class="tablewrap" id="tablewrap"></div>
  <div class="controlbar" id="controlbar"></div>
</main>
<script>
var S = { tab: 'bots', selected: null, note: null, noteKind: 'info', local: { pins: {}, blocked: {} }, last: null, feedDown: false }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] }) }
function t(ms) { return new Date(ms).toISOString().slice(11, 19) }
function chipHtml(text, cls) { return '<span class="chip ' + cls + '">' + esc(text) + '</span>' }
function codeHtml(text, cls) { return '<code class="' + (cls || 'code-color') + '">' + esc(text) + '</code>' }
function cell(html) { return '<div>' + html + '</div>' }

function doorCellHtml(b) {
  if (!b.hasDoor) return codeHtml('unsupported', 'muted')
  if (b.door === 'stalled') return chipHtml('stalled', 'chip-red')
  if (b.door === 'opening' || b.door === 'closing') return chipHtml(b.door, 'chip-amber')
  return codeHtml(b.door, 'code-color')
}

function linkChipHtml(b) {
  var pin = S.local.pins[b.botId]
  var pinned = pin === true || pin === false
  var text = (b.connected ? 'up' : 'down') + (pinned ? '*' : '')
  return chipHtml(text, b.connected ? 'chip-cyan' : 'chip-red')
}

function outcomeChipHtml(outcome) {
  if (/duplicate/.test(outcome)) return chipHtml(outcome, 'chip-neutral')
  if (/^(4|5|rejected|no response)/.test(outcome)) return chipHtml(outcome, 'chip-red')
  if (outcome === 'pending') return chipHtml(outcome, 'chip-neutral')
  return chipHtml(outcome, 'chip-cyan')
}

var VIEWS = {
  bots: {
    grid: '1.2fr 0.9fr 0.8fr 0.7fr 1.2fr 1.7fr 0.6fr 0.9fr 0.7fr',
    headers: ['bot', 'link', 'avail', 'batt', 'door', 'command', 'age', 'seq', 'drops'],
    rows: function (s) {
      return s.bots.map(function (b) {
        var ageText = b.lastPublishedAgeMs == null ? 'never' : Math.round(b.lastPublishedAgeMs / 1000) + 's'
        return {
          botId: b.botId,
          cells: [
            cell(codeHtml(b.botId, 'ink strong')),
            cell(linkChipHtml(b)),
            cell(codeHtml(b.available ? 'yes' : 'no', b.available ? 'code-color' : 'muted')),
            cell(codeHtml(b.batteryPercentage + '%', b.batteryPercentage < 20 ? 'bad-text strong' : 'code-color')),
            cell(doorCellHtml(b)),
            cell(codeHtml(b.command, 'code-color')),
            cell(codeHtml(ageText, 'muted')),
            cell(codeHtml(b.seq == null ? '—' : String(b.seq), 'muted')),
            cell(codeHtml(String(b.dropped), b.dropped > 0 ? 'bad-text strong' : 'muted')),
          ],
        }
      })
    },
  },
  commands: {
    grid: '0.7fr 1.1fr 1.3fr 1.8fr 0.6fr 1.9fr 0.8fr',
    headers: ['last', 'bot', 'type', 'id', 'sends', 'outcome', 'echo'],
    rows: function (s) {
      return s.commands.map(function (c) {
        return {
          botId: null,
          cells: [
            cell(codeHtml(t(c.lastAt), 'muted')),
            cell(codeHtml(c.botId, 'ink strong')),
            cell(codeHtml(c.type, 'code-color')),
            cell(codeHtml(c.commandId, 'muted')),
            cell(codeHtml('×' + c.sends, c.sends > 1 ? 'amber-text strong' : 'muted')),
            cell(outcomeChipHtml(c.outcome)),
            cell(codeHtml(c.echoLatencyMs == null ? '—' : c.echoLatencyMs + ' ms', 'muted')),
          ],
        }
      })
    },
  },
  events: {
    grid: '0.7fr 1.1fr 1.1fr 1.3fr 3fr',
    headers: ['at', 'bot', 'type', 'delivered', 'detail'],
    rows: function (s) {
      return s.events.map(function (e) {
        return {
          botId: null,
          cells: [
            cell(codeHtml(t(e.at), 'muted')),
            cell(codeHtml(e.botId, 'ink strong')),
            cell(codeHtml(e.type, 'code-color')),
            cell(chipHtml(e.delivered ? 'delivered' : 'not delivered', e.delivered ? 'chip-cyan' : 'chip-red')),
            cell('<span class="body-cell">' + esc(e.detail || '—') + '</span>'),
          ],
        }
      })
    },
  },
}

function renderTable() {
  var wrap = document.getElementById('tablewrap')
  var s = S.last
  if (!s) { wrap.innerHTML = ''; return }
  if (S.tab === 'log') {
    wrap.innerHTML = '<div class="logcard">' + s.log.map(function (l) {
      var bad = l.dropped || l.level === 'error'
      var lvlColor = bad ? 'var(--log-error)' : l.level === 'warn' ? 'var(--log-warn)' : 'var(--muted)'
      var msgColor = bad ? 'var(--log-error)' : 'var(--log-text)'
      return '<div class="logrow"><span class="at">' + esc(t(l.at)) + '</span>' +
        '<span class="lvl" style="color:' + lvlColor + '">' + esc(l.level) + '</span>' +
        '<span style="color:' + msgColor + '">' + esc(l.message) + '</span></div>'
    }).join('') + '</div>'
    return
  }
  var view = VIEWS[S.tab] || VIEWS.bots
  var rows = view.rows(s)
  var head = '<div class="thead" style="grid-template-columns:' + view.grid + '">' +
    view.headers.map(function (h) { return '<div>' + esc(h) + '</div>' }).join('') + '</div>'
  var body = rows.map(function (r) {
    var pickable = r.botId !== null
    var cls = 'trow' + (pickable ? ' pick' : '') + (pickable && r.botId === S.selected ? ' sel' : '')
    var attr = pickable ? ' data-botid="' + esc(r.botId) + '"' : ''
    return '<div class="' + cls + '"' + attr + ' style="grid-template-columns:' + view.grid + '">' + r.cells.join('') + '</div>'
  }).join('')
  wrap.innerHTML = '<div class="tbl">' + head + body + '</div>'
}

// key is only the TUI letter shown in the small chip (a/d/o/b); action is the endpoint slug
// act() and Task A's routes actually use (available/door/link/blocked) — they must not be
// conflated, or a click posts to /controls/a instead of /controls/available.
function pillHtml(key, action, label, value, on, disabled) {
  var cls = 'pill ' + (disabled ? 'disabled' : on ? 'on' : 'off')
  return '<button type="button" class="' + cls + '" data-act="' + action + '">' +
    '<span class="key">' + esc(key) + '</span><span>' + esc(label) + '</span>' +
    '<span class="strong">' + esc(value) + '</span></button>'
}

function renderControlBar() {
  var bar = document.getElementById('controlbar')
  var s = S.last
  if (!s || S.tab !== 'bots') { bar.innerHTML = ''; return }
  if (!s.controlsEnabled) {
    bar.innerHTML = '<div class="off-reason">Manual controls are off: this dashboard is bound to a non-loopback host, ' +
      'so the control routes were never mounted (loopback-only, by design). Restart with the default ' +
      '<code>127.0.0.1</code> host to use them.</div>'
    return
  }
  var row = s.bots.find(function (b) { return b.botId === S.selected })
  if (!row) {
    S.selected = null
    bar.innerHTML = '<div class="noterow"><span class="hint">Pick a row to select a bot. These controls drive the ' +
      'simulated robot directly, exactly like the TUI keys — they never touch remi.</span></div>'
    return
  }
  var html = '<div class="row"><div class="selected"><span class="label">Selected</span><code>' + esc(row.botId) + '</code></div>'
  if (!row.hasControls) {
    html += '<div class="hint">' + esc(row.botId) + '’s driver does not expose manual controls.</div></div>'
    bar.innerHTML = html
    return
  }
  var pin = S.local.pins[row.botId]
  var pinLabel = pin === true ? 'pinned down' : pin === false ? 'pinned up' : 'scenario'
  var blocked = S.local.blocked[row.botId] === true
  html += '<div class="pills">' +
    pillHtml('a', 'available', 'Available', row.available ? 'yes' : 'no', row.available, false) +
    pillHtml('d', 'door', 'Door', row.hasDoor ? row.door : 'unsupported', row.hasDoor && row.door === 'opened', !row.hasDoor) +
    pillHtml('o', 'link', 'Link', pinLabel, pin === true || pin === false, false) +
    pillHtml('b', 'blocked', 'Blocked', blocked ? 'yes' : 'no', blocked, false) +
    '</div></div>'
  html += '<div class="noterow">'
  if (S.note) {
    var iconColor = S.noteKind === 'warn' ? 'var(--amber-fg)' : 'var(--muted)'
    var textColor = S.noteKind === 'warn' ? '#8a4a12' : 'var(--body)'
    html += '<span class="note-icon" style="color:' + iconColor + '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>' +
      '</span><span class="note-text" style="color:' + textColor + '">' + esc(S.note) + '</span>'
  } else {
    html += '<span class="hint">These controls drive the simulated robot directly — they never touch remi.</span>'
  }
  html += '</div>'
  bar.innerHTML = html
}

function setNote(text, kind) { S.note = text; S.noteKind = kind || 'info'; renderControlBar() }

function errorNote(botId, data) {
  if (data && data.note) return data.note
  if (data && data.error === 'bot_not_found') return botId + ' not found.'
  if (data && data.error === 'no_controls') return botId + '’s driver does not expose manual controls.'
  if (data && data.error === 'no_door') return botId + ' has no door.'
  return 'That request failed.'
}

function act(kind) {
  var s = S.last
  if (!s) return
  var row = s.bots.find(function (b) { return b.botId === S.selected })
  if (!row) return
  if (kind === 'door' && !row.hasDoor) {
    setNote(row.botId + ' has no door (has_door: false) — remi never sends it a set_door.', 'warn')
    return
  }
  fetch('/api/bots/' + encodeURIComponent(row.botId) + '/controls/' + kind, { method: 'POST' })
    .then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) { return { res: res, data: data } })
    })
    .then(function (r) {
      var data = r.data
      if (!r.res.ok || !data || data.ok !== true) {
        setNote(errorNote(row.botId, data), 'warn')
        return
      }
      if (kind === 'available') {
        if (data.applied) setNote(row.botId + ' now reports available=' + (data.requested ? 'yes' : 'no') + '.', 'info')
        else setNote(data.note, 'warn')
      } else if (kind === 'door') {
        setNote('Door on ' + row.botId + ' moved to ' + data.door + ' locally — the driver’s own tick has the final word.', 'info')
      } else if (kind === 'link') {
        S.local.pins[row.botId] = data.pin
        setNote(row.botId + ' link → ' + data.label + '.', 'info')
      } else if (kind === 'blocked') {
        S.local.blocked[row.botId] = data.blocked
        setNote(data.blocked ? 'Emitted blocked(operator_test) for ' + row.botId + '.' : 'Emitted unblocked for ' + row.botId + '.', 'info')
      }
      render(S.last)
    })
    .catch(function () { setNote(kind + ' request failed.', 'warn') })
}

function render(s) {
  S.last = s
  document.getElementById('ns').textContent = s.namespace || '?'
  if (s.demo) document.getElementById('demoBanner').hidden = false
  document.getElementById('dashAddr').textContent = window.location.host || '?'

  var online = s.bots.filter(function (b) { return b.connected }).length
  document.getElementById('statOnline').firstChild.textContent = String(online)
  document.getElementById('statOf').textContent = '/' + s.bots.length
  var drops = s.bots.reduce(function (n, b) { return n + (b.dropped || 0) }, 0)
  var dropsEl = document.getElementById('statDrops')
  dropsEl.textContent = String(drops)
  dropsEl.classList.toggle('bad', drops > 0)

  var feedLabel = document.getElementById('feedLabel')
  var feedChip = document.getElementById('feedChip')
  var feedTime = document.getElementById('feedTime')
  var feedStat = document.getElementById('feedStat')
  if (S.feedDown) {
    feedLabel.textContent = 'Last snapshot'
    feedChip.textContent = 'feed lost'
    feedChip.className = 'chip chip-red'
    feedStat.classList.add('down')
  } else {
    feedLabel.textContent = 'Updated'
    feedChip.textContent = s.demo ? 'demo' : 'live'
    feedChip.className = 'chip ' + (s.demo ? 'chip-amber' : 'chip-cyan')
    feedStat.classList.remove('down')
  }
  feedTime.textContent = t(Date.now())

  document.getElementById('cnt-bots').textContent = String(s.bots.length)
  document.getElementById('cnt-commands').textContent = String(s.commands.length)
  document.getElementById('cnt-events').textContent = String(s.events.length)
  document.getElementById('cnt-log').textContent = String(s.log.length)

  renderTable()
  renderControlBar()
}

document.getElementById('tabs').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-tab]')
  if (!btn) return
  S.tab = btn.dataset.tab
  S.note = null
  document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b === btn) })
  renderTable()
  renderControlBar()
})

document.getElementById('tablewrap').addEventListener('click', function (e) {
  if (S.tab !== 'bots') return
  var row = e.target.closest('[data-botid]')
  if (!row) return
  S.selected = row.dataset.botid
  S.note = null
  renderTable()
  renderControlBar()
})

document.getElementById('controlbar').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-act]')
  if (!btn) return
  // The door pill stays clickable even when visibly disabled: act() explains why instead of
  // silently doing nothing (the same rule the available refusal note follows).
  act(btn.dataset.act)
})

fetch('/api/snapshot').then(function (r) { return r.json() }).then(render)
var es = new EventSource('/events')
es.addEventListener('snapshot', function (e) { S.feedDown = false; render(JSON.parse(e.data)) })
es.onerror = function () { S.feedDown = true; if (S.last) render(S.last) }
</script></body></html>`
