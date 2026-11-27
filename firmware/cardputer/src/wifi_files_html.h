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
*{box-sizing:border-box}
body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1321;color:#e8eef7;line-height:1.4}
.wrap{max-width:680px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;border-bottom:1px solid #243352;padding-bottom:12px;margin-bottom:14px}
h1{margin:0;font-size:1.3rem;color:#fff}
.meta{font-size:.9rem;color:#93a8c9}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 16px;border-radius:10px;border:0;font-size:.95rem;font-weight:600;text-decoration:none;cursor:pointer}
.btn:disabled{opacity:.45;cursor:default}
.btn-primary{background:#0ea5e9;color:#04121d;flex:1 1 200px}
.btn-primary.disabled{opacity:.45;pointer-events:none}
.btn-muted{background:#1e293b;color:#dce6f5}
.btn-dl{background:#1d4ed8;color:#fff;padding:8px 14px;min-height:40px}
.btn-del{background:#3b1822;color:#fca5a5;padding:8px 12px;min-height:40px}
.btn-del.armed{background:#b91c1c;color:#fff}
.msg{display:none;padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:.9rem;background:#3b1822;color:#fecaca}
.msg.warn{background:#3a2b12;color:#fde68a}
#popBox .btn{width:100%}
.note{font-size:.85rem;color:#93a8c9;margin:8px 0 16px}
.msg.show{display:block}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
li{background:#152038;border:1px solid #243352;border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.info{min-width:0;flex:1 1 180px}
.name{font-weight:600;word-break:break-all;color:#f8fafc}
.size{font-size:.85rem;color:#93a8c9;margin-top:2px}
.acts{display:flex;gap:8px}
.empty{background:#152038;border:1px solid #243352;border-radius:12px;padding:24px;text-align:center;color:#93a8c9}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>BioMapping Files</h1>
  <div class="meta" id="summary">Loading...</div>
</header>
<div id="popBox" hidden>
  <a class="btn btn-primary" id="openBtn" href="/">Open in browser to download</a>
  <p class="note">This pop-up can't save files. If your browser doesn't open, click <b>Done</b> and go to <b id="addr"></b> in it.</p>
</div>
<div class="bar">
  <a class="btn btn-primary disabled" id="zipBtn" href="/download-all.zip" download>Download All as ZIP</a>
  <button class="btn btn-muted" id="refreshBtn" type="button">Refresh</button>
  <button class="btn btn-del" id="delAllBtn" type="button" disabled>Delete All</button>
</div>
<div class="msg warn" id="warnBox"></div>
<div class="msg" id="errBox"></div>
<ul id="list"></ul>
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
const errBox = document.getElementById('errBox');
const warnBox = document.getElementById('warnBox');
const delAllBtn = document.getElementById('delAllBtn');
let fileTotal = 0;

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
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
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
  if (!secondTap(btn, 'Tap again to delete')) return;
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
  delAllBtn.textContent = 'Delete All';
  await loadFiles();
}

async function loadFiles() {
  showErr('');
  try {
    const r = await fetch('/api/files', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const files = data.files || [];
    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    summaryEl.textContent = files.length + (files.length === 1 ? ' file' : ' files') +
      ' \u00b7 ' + fmtSize(totalBytes) + (data.ssid ? ' \u00b7 ' + data.ssid : '');
    showWarn(data.truncated
      ? 'Showing the newest ' + files.length + ' of ' + data.total +
        ' recordings. Download All as ZIP still includes every file.'
      : '');
    zipBtn.className = files.length ? 'btn btn-primary' : 'btn btn-primary disabled';
    fileTotal = data.truncated ? data.total : files.length;
    delAllBtn.disabled = !fileTotal;
    listEl.textContent = '';
    if (!files.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = 'No recordings found on the SD card yet.';
      listEl.appendChild(div);
      return;
    }
    for (const f of files) {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'info';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = f.name;
      const sz = document.createElement('div');
      sz.className = 'size';
      sz.textContent = fmtSize(f.size);
      info.appendChild(nm);
      info.appendChild(sz);

      const acts = document.createElement('div');
      acts.className = 'acts';
      if (!inSignIn) {
        const dl = document.createElement('a');
        dl.className = 'btn btn-dl';
        dl.href = '/download?name=' + encodeURIComponent(f.name);
        dl.setAttribute('download', f.name);
        dl.textContent = 'Download';
        acts.appendChild(dl);
      }
      const del = document.createElement('button');
      del.className = 'btn btn-del';
      del.type = 'button';
      del.textContent = 'Delete';
      del.onclick = () => deleteFile(f.name, del);
      acts.appendChild(del);

      li.appendChild(info);
      li.appendChild(acts);
      listEl.appendChild(li);
    }
  } catch (e) {
    summaryEl.textContent = 'Disconnected';
    showErr('Could not load file list. Check you are still connected to the Cardputer Wi-Fi.');
  }
}

if (inSignIn) {
  document.getElementById('popBox').hidden = false;
  document.getElementById('openBtn').href = location.origin + '/';
  document.getElementById('addr').textContent = location.host;
  zipBtn.style.display = 'none';
}
document.getElementById('refreshBtn').onclick = loadFiles;
delAllBtn.onclick = deleteAll;
loadFiles();
</script>
</body>
</html>
)HTML";
