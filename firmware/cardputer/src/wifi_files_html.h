#pragma once

// Embedded mobile-friendly web page for Wi-Fi Files (stored in flash).

#include <Arduino.h>

static const char INDEX_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BioMapping Files</title>
<style>
/* Colours and fonts, all in one place. */
:root{
  --bg:#0b1120;--panel:#121a2d;--panel-2:#172238;--line:#223050;
  --text:#e8eef7;--muted:#8b9cba;--faint:#5f7193;
  --accent:#38bdf8;--accent-ink:#04121d;--blue-bg:#1a2f5c;--blue-text:#a5c8ff;
  --ok:#4ade80;--warn:#fbbf24;--danger:#f87171;--danger-bg:#3a1620;--danger-solid:#dc2626;
  --sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:20px 16px 32px;background:var(--bg);color:var(--text);font:16px/1.4 var(--sans);font-variant-numeric:tabular-nums}
.wrap{max-width:640px;margin:0 auto}

/* Top: device name (big, top left), then what's on the card and the battery. */
header{padding-bottom:14px;margin-bottom:18px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:clamp(1.75rem,9vw,2.5rem);line-height:1.1;font-weight:700;letter-spacing:-.015em;white-space:nowrap}
h1 .pre{color:var(--muted);font-weight:600}
h1 .id{color:var(--accent);font-family:var(--mono);letter-spacing:.02em}
.meta{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;font-size:.92rem;color:var(--muted)}
.bad{color:var(--danger)}
.batt{flex:none;display:flex;align-items:center;gap:7px;font-size:.95rem;font-weight:600;color:var(--text)}
.cell{position:relative;width:26px;height:13px;padding:1.5px;border:1.5px solid var(--muted);border-radius:3px}
.cell::after{content:"";position:absolute;right:-4.5px;top:2.5px;width:2.5px;height:5px;border-radius:0 1px 1px 0;background:var(--muted)}
.cell i{display:block;height:100%;border-radius:1px;background:var(--ok)}
.batt.low{color:var(--warn)}.batt.low .cell i{background:var(--warn)}
.batt.crit{color:var(--danger)}.batt.crit .cell i{background:var(--danger)}

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:0 16px;border:1px solid transparent;border-radius:11px;font:600 .95rem/1 var(--sans);text-decoration:none;cursor:pointer;white-space:nowrap}
.btn svg{width:18px;height:18px;flex:none}
.btn:disabled,.btn.disabled{opacity:.4;pointer-events:none}
.btn-primary{flex:1;background:var(--accent);color:var(--accent-ink)}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--line)}
.btn-sm{min-height:38px;padding:0 11px;border-radius:8px;font-size:.88rem}
.btn-dl{background:var(--blue-bg);color:var(--blue-text)}
.btn-del{background:transparent;color:var(--danger)}
.btn-del-all{background:var(--danger-bg);color:var(--danger)}
.btn-del.armed,.btn-del-all.armed{background:var(--danger-solid);color:#fff}
.bar{display:flex;gap:10px;margin-bottom:6px}

/* Messages and the Apple pop-up box */
.msg{display:none;margin:14px 0 0;padding:10px 12px;border-radius:10px;font-size:.9rem;background:var(--danger-bg);color:#fecaca}
.msg.warn{background:#33270f;color:#fde68a}
.msg.show{display:block}
.pop{margin-bottom:18px;padding:14px;background:var(--panel-2);border:1px solid var(--line);border-radius:14px}
.pop .btn{width:100%}
.btn.busy{opacity:.7;pointer-events:none}
.note{margin:10px 2px 0;font-size:.85rem;color:var(--muted)}

/* Recordings, grouped by day */
.day{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:24px 4px 8px;font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.day span:last-child{font-weight:500;letter-spacing:0;text-transform:none;color:var(--faint)}
ul{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
li{display:flex;align-items:center;gap:10px;min-height:62px;padding:10px 10px 10px 16px}
li+li{border-top:1px solid var(--line)}
.info{flex:1;min-width:0}
.num{font:.78rem var(--mono)}
.when{font-size:1.1rem;font-weight:600}
.when.none{font-size:.95rem;font-weight:500;color:var(--muted)}
.when small{margin-left:4px;font-size:.8rem;font-weight:400;color:var(--muted)}
.fname{font:.85rem var(--mono);word-break:break-all}
.size{margin-top:1px;font-size:.82rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acts{flex:none;display:flex;gap:4px}
.empty{padding:32px 16px;margin-top:18px;text-align:center;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:14px}

/* Bottom: delete everything, firmware */
.foot{display:flex;flex-direction:column;align-items:flex-start;gap:14px;margin-top:32px;padding-top:18px;border-top:1px solid var(--line)}
.fw{font:.75rem var(--mono);color:var(--faint)}

/* Small phones */
@media (max-width:359px){
  li{gap:6px;padding-left:12px}
  .btn-sm{padding:0 9px;font-size:.84rem}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1><span class="pre" id="devPre">BioMapping</span><span class="id" id="devId"></span></h1>
  <div class="meta">
    <span id="summary">Loading&hellip;</span>
    <span class="batt" id="batt" title="Battery" hidden><span class="cell"><i id="battFill"></i></span><span id="battPct"></span></span>
  </div>
</header>
<div class="pop" id="popBox" hidden>
  <a class="btn btn-primary" id="openBtn" href="/">Open in browser to download</a>
  <p class="note">This pop-up can't save files. Press once: your browser can take up to half a minute to show the page. If it doesn't open, click <b>Done</b> and go to <b id="addr"></b> in it.</p>
</div>
<div class="bar">
  <a class="btn btn-primary disabled" id="zipBtn" href="/download-all.zip" download>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
    Download all</a>
  <button class="btn btn-ghost" id="refreshBtn" type="button">Refresh</button>
</div>
<div class="msg warn" id="warnBox"></div>
<div class="msg" id="errBox"></div>
<div id="list"></div>
<div class="foot">
  <button class="btn btn-del-all" id="delAllBtn" type="button" hidden>Delete all recordings</button>
  <div class="fw" id="fw"></div>
</div>
</div>
<script>
// Apple's Wi-Fi sign-in pop-up (it opens by itself on joining) is a
// cut-down browser: it can't save files, and it answers every confirm()
// box with "no". Its user agent names AppleWebKit but not Safari
// (wifi_files_client_kind() has the same rule). There the page has no
// download buttons, just one plain link to itself: the Cardputer makes the
// pop-up count as online as soon as it opens (handle_not_found()), and on
// a Mac an online pop-up hands plain links to the normal browser. Apple
// doesn't document this, so the note also says how to do it by hand.
const ua = navigator.userAgent;
const inSignIn = /AppleWebKit/.test(ua) && !/Safari\//.test(ua) &&
                 /(Macintosh|iPhone|iPad|iPod)/.test(ua);
const listEl = document.getElementById('list');
const summaryEl = document.getElementById('summary');
const zipBtn = document.getElementById('zipBtn');
const refreshBtn = document.getElementById('refreshBtn');
const errBox = document.getElementById('errBox');
const warnBox = document.getElementById('warnBox');
const delAllBtn = document.getElementById('delAllBtn');
const DEL_ALL_LABEL = delAllBtn.textContent;
let fileTotal = 0;

// The device name is the Wi-Fi name, BioMapping-XXXX. Only the part after
// the dash differs between Cardputers, so that part is shown bright, and it
// also names the browser tab.
function showDevice(ssid) {
  if (!ssid) return;
  const cut = ssid.lastIndexOf('-') + 1;
  document.getElementById('devPre').textContent = ssid.slice(0, cut);
  document.getElementById('devId').textContent = ssid.slice(cut);
  document.title = ssid;
}

// -1 (or nothing) means the Cardputer couldn't read its battery.
function showBattery(pct) {
  const box = document.getElementById('batt');
  if (typeof pct !== 'number' || pct < 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = 'batt' + (pct < 15 ? ' crit' : pct < 30 ? ' low' : '');
  document.getElementById('battFill').style.width = Math.max(6, Math.min(100, pct)) + '%';
  document.getElementById('battPct').textContent = pct + '%';
}

function showErr(text) {
  errBox.textContent = text || '';
  errBox.className = text ? 'msg show' : 'msg';
}

function showWarn(text) {
  warnBox.textContent = text || '';
  warnBox.className = text ? 'msg warn show' : 'msg warn';
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// Recording names: biomap_0042_2026-11-21_14-32-05.csv, biomap_0043_nodate.csv
// (no GPS time yet), "_2" before ".csv" when the name was already taken, and
// older names with no number. Anything else is listed under "Other files".
const NAME_RE = /^biomap_(?:(\d+)_)?(?:(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-\d\d|nodate)(_\d+)?\.csv$/i;

function describe(name) {
  const m = NAME_RE.exec(name);
  if (!m) return { day: 'other', num: '', time: '', extra: '' };
  const out = { day: 'nodate', num: m[1] || '', time: '', extra: m[7] || '' };
  if (m[2]) {
    out.day = m[2] + '-' + m[3] + '-' + m[4];
    out.time = m[5] + ':' + m[6];
  }
  return out;
}

function dayLabel(day) {
  if (day === 'nodate') return 'No date';
  if (day === 'other') return 'Other files';
  const [y, mo, d] = day.split('-').map(Number);
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, mo - 1, d).toLocaleDateString('en-GB', opts);
}

// A delete asks for a second tap on the same button (within 4 s) rather
// than a confirm() box, which the sign-in window can't show. True on the
// second tap.
function secondTap(btn, askText) {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '';
    btn.classList.remove('armed');
    return true;
  }
  const label = btn.textContent;
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = askText;
  setTimeout(() => {
    if (btn.dataset.armed !== '1') return;
    btn.dataset.armed = '';
    btn.classList.remove('armed');
    btn.textContent = label;
  }, 4000);
  return false;
}

async function deleteFile(name, btn) {
  if (!secondTap(btn, 'Tap again')) return;
  showErr('');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const r = await fetch('/api/delete?name=' + encodeURIComponent(name), { method: 'POST' });
    if (!r.ok) throw new Error('Delete failed (' + r.status + ')');
    await loadFiles();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Delete';
    showErr('Could not delete file. Check the Cardputer is still on Wi-Fi Files.');
  }
}

async function deleteAll() {
  const n = fileTotal;
  if (!n) return;
  if (!secondTap(delAllBtn, 'Tap again to delete all ' + n)) return;
  showErr('');
  delAllBtn.disabled = true;
  delAllBtn.textContent = 'Deleting...';
  try {
    const r = await fetch('/api/delete-all', { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Delete failed (' + r.status + ')');
    if (data.failed) showErr(data.failed + ' file(s) could not be deleted.');
  } catch (e) {
    showErr('Could not delete files. Check the Cardputer is still on Wi-Fi Files.');
  }
  delAllBtn.disabled = false;
  delAllBtn.textContent = DEL_ALL_LABEL;
  await loadFiles();
}

function fileRow(it) {
  const f = it.f;
  const d = it.d;
  const li = document.createElement('li');
  li.title = f.name;

  const info = document.createElement('div');
  info.className = 'info';
  const when = document.createElement('div');
  if (d.time) {
    when.className = 'when';
    when.textContent = d.time;
  } else if (d.day === 'nodate') {
    when.className = 'when none';
    when.textContent = it.after || 'Time unknown';
  } else {
    when.className = 'fname';
    when.textContent = f.name;
  }
  if (d.extra) {
    const s = document.createElement('small');
    s.textContent = d.extra;
    when.appendChild(s);
  }
  // Second line: recording number (as in the file name) and size.
  const sub = document.createElement('div');
  sub.className = 'size';
  if (d.num) {
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '#' + d.num;
    sub.appendChild(num);
    sub.appendChild(document.createTextNode(' \u00b7 '));
  }
  sub.appendChild(document.createTextNode(fmtSize(f.size)));
  info.appendChild(when);
  info.appendChild(sub);

  const acts = document.createElement('div');
  acts.className = 'acts';
  if (!inSignIn) {
    const dl = document.createElement('a');
    dl.className = 'btn btn-sm btn-dl';
    dl.href = '/download?name=' + encodeURIComponent(f.name);
    dl.setAttribute('download', f.name);
    dl.textContent = 'Download';
    acts.appendChild(dl);
  }
  const del = document.createElement('button');
  del.className = 'btn btn-sm btn-del';
  del.type = 'button';
  del.textContent = 'Delete';
  del.onclick = () => deleteFile(f.name, del);
  acts.appendChild(del);

  li.appendChild(info);
  li.appendChild(acts);
  return li;
}

// Files arrive newest first by recording number (recording_number.h), which
// goes up by one for every recording, so that order is right even for the
// ones with no date, and the list keeps it. A recording with no date sits
// between two dated ones in that order; when those two are on the same day
// it must be from that day too, so it's listed there, after the older one's
// start time. Otherwise it gets its own "No date" heading at its place in
// the order.
function placeFiles(files) {
  const items = files.map(f => ({ f, d: describe(f.name), day: '', after: '' }));
  items.forEach((it, i) => {
    it.day = it.d.day;
    if (it.d.day !== 'nodate' || !it.d.num) return;
    let newer = null;
    let older = null;
    for (let j = i - 1; j >= 0 && !newer; j--) if (items[j].d.time) newer = items[j];
    for (let j = i + 1; j < items.length && !older; j++) if (items[j].d.time) older = items[j];
    if (newer && older && older.d.num && newer.d.day === older.d.day) {
      it.day = newer.d.day;
      it.after = 'After ' + older.d.time;
    }
  });
  return items;
}

function showFiles(files) {
  listEl.textContent = '';
  if (!files.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No recordings on this Cardputer yet.';
    listEl.appendChild(div);
    return;
  }
  // A new heading each time the day changes going down the list.
  const groups = [];
  for (const it of placeFiles(files)) {
    const last = groups[groups.length - 1];
    if (last && last.day === it.day) last.items.push(it);
    else groups.push({ day: it.day, items: [it] });
  }
  for (const g of groups) {
    const h = document.createElement('h2');
    h.className = 'day';
    const label = document.createElement('span');
    label.textContent = dayLabel(g.day);
    const count = document.createElement('span');
    count.textContent = plural(g.items.length, 'recording');
    h.appendChild(label);
    h.appendChild(count);
    const ul = document.createElement('ul');
    for (const it of g.items) ul.appendChild(fileRow(it));
    listEl.appendChild(h);
    listEl.appendChild(ul);
  }
}

async function loadFiles() {
  showErr('');
  refreshBtn.disabled = true;
  try {
    const r = await fetch('/api/files', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const files = data.files || [];
    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    showDevice(data.ssid);
    showBattery(data.battery);
    fileTotal = data.truncated ? data.total : files.length;
    summaryEl.className = '';
    summaryEl.textContent = !fileTotal ? 'No recordings'
      : plural(fileTotal, 'recording') + (data.truncated ? '' : ' \u00b7 ' + fmtSize(totalBytes));
    showWarn(data.truncated
      ? 'Showing the newest ' + files.length + ' of ' + data.total +
        ' recordings. Download all still includes every file.'
      : '');
    zipBtn.classList.toggle('disabled', !files.length);
    delAllBtn.hidden = !fileTotal;
    document.getElementById('fw').textContent = data.firmware ? 'Firmware ' + data.firmware : '';
    showFiles(files);
  } catch (e) {
    summaryEl.className = 'bad';
    summaryEl.textContent = 'Not connected';
    showErr('Could not load the recordings. Check you are still connected to the Cardputer Wi-Fi.');
  }
  refreshBtn.disabled = false;
}

if (inSignIn) {
  const openBtn = document.getElementById('openBtn');
  const openLabel = openBtn.textContent;
  document.getElementById('popBox').hidden = false;
  openBtn.href = location.origin + '/';
  document.getElementById('addr').textContent = location.host;
  zipBtn.hidden = true;
  // The browser can take half a minute to show the page (on a Mac set to
  // find its proxy settings by itself, it does that first), and each press
  // opens another tab. So a press shows it worked and is ignored for 30 s.
  openBtn.addEventListener('click', () => {
    setTimeout(() => {
      openBtn.textContent = 'Opening in your browser\u2026';
      openBtn.classList.add('busy');
    }, 0);
    setTimeout(() => {
      openBtn.textContent = openLabel;
      openBtn.classList.remove('busy');
    }, 30000);
  });
}
refreshBtn.onclick = loadFiles;
delAllBtn.onclick = deleteAll;
loadFiles();
</script>
</body>
</html>
)HTML";
