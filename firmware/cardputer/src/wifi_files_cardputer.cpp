#include "wifi_files_cardputer.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <dirent.h>
#include <errno.h>
#include <esp_mac.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <new>
#include <stdint.h>

#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "keys.h"
#include "sd_cardputer.h"
#include "settings_cardputer.h"
#include "wifi_files_rules.h"
#include "zip_stream.h"

static const char* const DIR_PATH = "/sd/biomapping";
static const size_t      IO_BUF_BYTES = 4096;
static const size_t      MAX_LIST_FILES = 256;  // web page list only; the ZIP takes every file
static const uint32_t    CLIENT_POLL_MS = 250;
static const uint32_t    WRITE_STALL_TIMEOUT_MS = 10000;
static const int         SOCKET_WAIT_US = 50000;  // 50 ms so Esc responds quickly on stalls
static const uint32_t    PROGRESS_UI_MS = 250;
static const uint32_t    STATUS_FLASH_MS = 3000;
static const uint8_t     QR_BRIGHTNESS = 128;
static const uint32_t    IDLE_OFF_MS = 10UL * 60UL * 1000UL;  // turn off after 10 min with no device

// Custom RGB565 theme colour matching menu_cardputer.cpp.
static const uint16_t COL_MUTED = 0x8410;

// Devices that chose to continue in a browser: Apple's sign-in check is
// answered "Success" for them (wifi_files_rules.h, "Apple's Wi-Fi sign-in
// window"). Cleared when the hotspot starts and stops.
static WifiFilesReleased g_released;

// Screen layout: the QR code fills the full 135 px height on the left; text
// sits in the 101 px column on the right.
static const int SCREEN_W = 240;
static const int SCREEN_H = 135;
static const int QR_SIZE  = SCREEN_H;
static const int PANEL_X  = QR_SIZE + 4;
static const int PANEL_W  = SCREEN_W - PANEL_X - 2;
static const int STATUS_Y = 96;

static struct {
    bool       active = false;
    bool       wants_exit = false;
    bool       show_url_qr = false;
    bool       manual_qr = false;
    bool       dirty = false;
    bool       status_timed = false;
    WebServer* server = nullptr;
    DNSServer* dns = nullptr;
    M5Canvas*  canvas = nullptr;
    uint8_t*   io_buf = nullptr;
    char       ssid[32] = "";
    char       qr_wifi[80] = "";
    char       qr_url[48] = "";
    char       status_line[48] = "";
    uint16_t   status_col = TFT_GREEN;
    uint32_t   status_since_ms = 0;
    uint32_t   last_client_poll_ms = 0;
    uint32_t   last_progress_draw_ms = 0;
    uint32_t   idle_since_ms = 0;
    uint32_t   idle_mins_shown = 0;
    int        client_count = 0;
    int        file_count = 0;
    uint64_t   total_bytes = 0;
} g_wf;

// ── Embedded mobile-friendly web page (stored in flash) ──────────────────

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
.msg a{color:inherit;font-weight:700}
.msg.warn{background:#3a2b12;color:#fde68a}
.msg.show{display:block}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
li{background:#152038;border:1px solid #243352;border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.info{min-width:0;flex:1 1 180px}
.name{font-weight:600;word-break:break-all;color:#f8fafc}
.size{font-size:.85rem;color:#93a8c9;margin-top:2px}
.acts{display:flex;gap:8px}
.hint{margin-top:18px;font-size:.85rem;color:#93a8c9}
.hint a{color:#7dd3fc}
.empty{background:#152038;border:1px solid #243352;border-radius:12px;padding:24px;text-align:center;color:#93a8c9}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>BioMapping Files</h1>
  <div class="meta" id="summary">Loading...</div>
</header>
<div class="bar">
  <a class="btn btn-primary disabled" id="zipBtn" href="/download-all.zip" download>Download All as ZIP</a>
  <button class="btn btn-muted" id="refreshBtn" type="button">Refresh</button>
  <button class="btn btn-del" id="delAllBtn" type="button" disabled>Delete All</button>
</div>
<div class="msg warn" id="signInBox">This Wi-Fi sign-in window can't save files. <a href="/browser">Continue in Safari</a> to download.</div>
<div class="msg warn" id="warnBox"></div>
<div class="msg" id="errBox"></div>
<ul id="list"></ul>
<p class="hint">Download not starting? Wi-Fi sign-in windows can't save files: <a href="/browser">continue in your browser</a> instead.</p>
</div>
<script>
// Apple's Wi-Fi sign-in window (it opens by itself on joining) is a
// cut-down browser: it can't save files, and it answers every confirm()
// box with "no". Its user agent names AppleWebKit but not Safari. There,
// Download goes to the "continue in Safari" page instead.
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
      const dl = document.createElement('a');
      dl.className = 'btn btn-dl';
      if (inSignIn) {
        dl.href = '/browser';
      } else {
        dl.href = '/download?name=' + encodeURIComponent(f.name);
        dl.setAttribute('download', f.name);
      }
      dl.textContent = 'Download';
      const del = document.createElement('button');
      del.className = 'btn btn-del';
      del.type = 'button';
      del.textContent = 'Delete';
      del.onclick = () => deleteFile(f.name, del);
      acts.appendChild(dl);
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
  document.getElementById('signInBox').className = 'msg warn show';
  zipBtn.href = '/browser';
  zipBtn.removeAttribute('download');
}
document.getElementById('refreshBtn').onclick = loadFiles;
delAllBtn.onclick = deleteAll;
loadFiles();
</script>
</body>
</html>
)HTML";

// ── File scanning & path helpers ─────────────────────────────────────────

struct CsvFileList {
    ZipStreamEntry* items = nullptr;
    size_t          count = 0;
    size_t          total_found = 0;
    uint64_t        total_bytes = 0;
    bool            truncated = false;
    bool            alloc_ok = true;

    ~CsvFileList() { delete[] items; }
    CsvFileList() = default;
    CsvFileList(const CsvFileList&) = delete;
    CsvFileList& operator=(const CsvFileList&) = delete;
};

static bool build_csv_path(const char* name, char* out, size_t out_sz) {
    if(!wifi_files_name_valid(name)) return false;
    int n = snprintf(out, out_sz, "%s/%s", DIR_PATH, name);
    return n > 0 && (size_t)n < out_sz;
}

static void fill_zip_entry(ZipStreamEntry* dst, const char* name, uint32_t size) {
    memset(dst, 0, sizeof(*dst));
    strncpy(dst->name, name, sizeof(dst->name) - 1);
    dst->size = size;
    wifi_files_dos_datetime_from_name(dst->name, &dst->dos_date, &dst->dos_time);
}

static int compare_entries_desc(const void* a, const void* b) {
    return wifi_files_name_compare(static_cast<const ZipStreamEntry*>(b)->name,
                                   static_cast<const ZipStreamEntry*>(a)->name);
}

static size_t find_oldest_index(const ZipStreamEntry* items, size_t count) {
    size_t min_idx = 0;
    for(size_t i = 1; i < count; i++) {
        if(wifi_files_name_compare(items[i].name, items[min_idx].name) < 0) min_idx = i;
    }
    return min_idx;
}

// Scans /sd/biomapping for valid .csv files, refreshing g_wf.file_count and
// g_wf.total_bytes. When `out` is non-null, also collects up to `max_items`
// newest entries in a single nothrow allocation, sorted newest-first.
static void scan_csv_dir(CsvFileList* out, size_t max_items) {
    if(out) {
        delete[] out->items;
        out->items = nullptr;
        out->count = 0;
        out->total_found = 0;
        out->total_bytes = 0;
        out->truncated = false;
        out->alloc_ok = true;
    }
    if(!sd_card_ready()) {
        g_wf.file_count = 0;
        g_wf.total_bytes = 0;
        return;
    }

    size_t cap = 0;
    if(out) {
        DIR* dir = opendir(DIR_PATH);
        if(!dir) return;
        size_t est = 0;
        for(struct dirent* ent; (ent = readdir(dir)) != nullptr;) {
            if(wifi_files_name_valid(ent->d_name)) est++;
        }
        closedir(dir);
        if(est == 0) {
            g_wf.file_count = 0;
            g_wf.total_bytes = 0;
            return;
        }
        cap = est > max_items ? max_items : est;
        out->items = new (std::nothrow) ZipStreamEntry[cap];
        if(!out->items) {
            out->alloc_ok = false;
            return;
        }
    }

    DIR* dir = opendir(DIR_PATH);
    if(!dir) return;

    size_t found = 0;
    uint64_t bytes = 0;
    size_t min_idx = 0;
    bool min_valid = false;

    for(struct dirent* ent; (ent = readdir(dir)) != nullptr;) {
        char full[128];
        if(!build_csv_path(ent->d_name, full, sizeof(full))) continue;

        struct stat st;
        if(stat(full, &st) != 0 || !S_ISREG(st.st_mode)) continue;
        if(st.st_size < 0 || (uint64_t)st.st_size > 0x7FFFFFFFULL) continue;

        found++;
        bytes += (uint64_t)st.st_size;
        if(!out) continue;

        if(out->count < cap) {
            fill_zip_entry(&out->items[out->count++], ent->d_name, (uint32_t)st.st_size);
        } else {
            out->truncated = true;
            if(!min_valid) {
                min_idx = find_oldest_index(out->items, out->count);
                min_valid = true;
            }
            if(wifi_files_name_compare(ent->d_name, out->items[min_idx].name) > 0) {
                fill_zip_entry(&out->items[min_idx], ent->d_name, (uint32_t)st.st_size);
                min_valid = false;
            }
        }
    }
    closedir(dir);

    g_wf.file_count = (int)found;
    g_wf.total_bytes = bytes;
    if(out) {
        out->total_found = found;
        out->total_bytes = bytes;
        if(out->count > 1) {
            qsort(out->items, out->count, sizeof(ZipStreamEntry), compare_entries_desc);
        }
    }
}

// ── Transfer responsiveness, status line, and streaming I/O ──────────────

static bool poll_escape_during_transfer(void) {
    M5Cardputer.update();
    keys_unstick_poll();
    if(M5Cardputer.Keyboard.isChange() && M5Cardputer.Keyboard.isPressed()) {
        SessionKey key;
        if(keys_to_session(M5Cardputer.Keyboard.keysState(), &key) &&
           key == SessionKeyBack) {
            g_wf.wants_exit = true;
            return true;
        }
    }
    while(Serial.available() > 0) {
        int ch = Serial.read();
        if(ch == '`' || ch == '~' || ch == 0x1B || ch == 0x7F) {
            g_wf.wants_exit = true;
            return true;
        }
    }
    return g_wf.wants_exit;
}

// Draws one line of text in the right-hand column, dropping to the small
// font when it would not fit in the column's width.
static void draw_fit(M5Canvas& canvas, const char* text, int y, uint16_t col) {
    canvas.setTextDatum(textdatum_t::top_left);
    canvas.setTextColor(col);
    canvas.setFont(&fonts::Font2);
    if(canvas.textWidth(text) > PANEL_W) {
        canvas.setFont(&fonts::Font0);
        canvas.drawString(text, PANEL_X, y + 4);
        canvas.setFont(&fonts::Font2);
    } else {
        canvas.drawString(text, PANEL_X, y);
    }
}

// Redraws only the single status/file-count line in the right panel (no QR
// re-encoding while streaming data).
static void draw_status_line(M5Canvas& canvas) {
    canvas.fillRect(PANEL_X, STATUS_Y, SCREEN_W - PANEL_X, 18, TFT_BLACK);
    if(g_wf.status_line[0]) {
        draw_fit(canvas, g_wf.status_line, STATUS_Y, g_wf.status_col);
    } else if(g_wf.file_count == 0) {
        draw_fit(canvas, "No CSV files", STATUS_Y, TFT_LIGHTGREY);
    } else {
        char szbuf[16];
        wifi_files_format_size(g_wf.total_bytes, szbuf, sizeof(szbuf));
        char fbuf[32];
        snprintf(fbuf, sizeof(fbuf), "%d CSV, %s", g_wf.file_count, szbuf);
        draw_fit(canvas, fbuf, STATUS_Y, TFT_LIGHTGREY);
    }
}

static void update_transfer_ui(const char* text, bool force_draw) {
    snprintf(g_wf.status_line, sizeof(g_wf.status_line), "%s", text ? text : "");
    g_wf.status_col = TFT_YELLOW;
    g_wf.status_timed = false;
    uint32_t now = millis();
    if(g_wf.canvas && (force_draw || now - g_wf.last_progress_draw_ms >= PROGRESS_UI_MS)) {
        g_wf.last_progress_draw_ms = now;
        draw_status_line(*g_wf.canvas);
        g_wf.canvas->pushSprite(0, 0);
    }
}

static void set_flash_status(const char* msg, uint16_t col) {
    if(msg && msg[0]) {
        snprintf(g_wf.status_line, sizeof(g_wf.status_line), "%s", msg);
        g_wf.status_col = col;
        g_wf.status_timed = true;
        g_wf.status_since_ms = millis();
    } else {
        g_wf.status_line[0] = '\0';
        g_wf.status_timed = false;
    }
    g_wf.dirty = true;
}

// Writes `len` bytes to `client` using 50 ms select() waits + non-blocking
// send(), so pressing Esc cancels a stalled download within ~50 ms instead of
// blocking inside Arduino's 10-second NetworkClient::write() loop.
static bool client_write_all(NetworkClient& client, const uint8_t* data, size_t len) {
    int sock = client.fd();
    if(sock < 0 || sock >= FD_SETSIZE) return false;
    size_t sent = 0;
    uint32_t last_progress_ms = millis();
    while(sent < len) {
        if(!client.connected() || poll_escape_during_transfer()) return false;

        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(sock, &wfds);
        struct timeval tv = {0, SOCKET_WAIT_US};

        int sel = select(sock + 1, nullptr, &wfds, nullptr, &tv);
        if(sel < 0) {
            if(errno == EINTR) continue;
            return false;
        }
        if(sel > 0 && FD_ISSET(sock, &wfds)) {
            ssize_t n = send(sock, data + sent, len - sent, MSG_DONTWAIT);
            if(n > 0) {
                sent += (size_t)n;
                last_progress_ms = millis();
                continue;
            }
            if(n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
                return false;
            }
        }
        if(millis() - last_progress_ms >= WRITE_STALL_TIMEOUT_MS) return false;
        yield();
    }
    return true;
}

typedef bool (*StreamChunkFn)(void* ctx, const uint8_t* data, size_t len);
typedef void (*StreamProgressFn)(void* ctx, uint32_t done);

// Reads exactly `size` bytes from `fd` in IO_BUF_BYTES chunks, passing each
// chunk to `write_chunk` and updating progress.
static bool stream_fd_exact(int fd, uint32_t size,
                            StreamChunkFn write_chunk, void* write_ctx,
                            StreamProgressFn on_progress, void* prog_ctx) {
    uint32_t done = 0;
    while(done < size) {
        size_t want = size - done;
        if(want > IO_BUF_BYTES) want = IO_BUF_BYTES;
        ssize_t got = read(fd, g_wf.io_buf, want);
        if(got <= 0) return false;
        if(!write_chunk(write_ctx, g_wf.io_buf, (size_t)got)) return false;
        done += (uint32_t)got;
        if(on_progress) on_progress(prog_ctx, done);
        yield();
    }
    return true;
}

static void send_attachment_headers(const char* filename, const char* mime, uint32_t length) {
    char disp[WIFI_FILES_MAX_NAME + 32];
    snprintf(disp, sizeof(disp), "attachment; filename=\"%s\"", filename);
    g_wf.server->setContentLength(length);
    g_wf.server->sendHeader("Content-Disposition", disp);
    g_wf.server->sendHeader("Cache-Control", "no-store");
    g_wf.server->send(200, mime, "");
}

// ── HTTP route handlers ──────────────────────────────────────────────────

// Sends the status line and headers through the library (they fit in the
// fresh connection's empty send buffer, so they never wait), then the body
// through client_write_all(). The library's own body writes wait up to 10 s per
// piece when a phone drops off the hotspot mid-reply, and the file list is
// many pieces, so a vanished phone could hold the whole Cardputer for minutes.
static bool send_body_own_writer(const char* mime, const char* body, size_t len) {
    g_wf.server->setContentLength(len);
    g_wf.server->sendHeader("Cache-Control", "no-store");
    g_wf.server->send(200, mime, "");
    NetworkClient client = g_wf.server->client();
    bool ok = client_write_all(client, reinterpret_cast<const uint8_t*>(body), len);
    if(!ok) {
        client.stop();
        Serial.println("[WiFi] reply stopped (device gone or Esc)");
    }
    return ok;
}

static void handle_index(void) {
    send_body_own_writer("text/html; charset=utf-8", INDEX_HTML, strlen(INDEX_HTML));
}

static void handle_no_content(void) {
    g_wf.server->send(204, "", "");
}

// Writes the file list JSON into `out` (when non-null) and returns its length,
// so the caller can size the buffer with a first pass of out == nullptr.
static size_t format_files_json(const CsvFileList& files, char* out) {
    char esc[WIFI_FILES_MAX_NAME * 2];
    char chunk[256];
    size_t len = 0;
    auto put = [&](int n) {
        if(n <= 0) return;
        size_t k = (size_t)n < sizeof(chunk) ? (size_t)n : sizeof(chunk) - 1;
        if(out) memcpy(out + len, chunk, k);
        len += k;
    };
    wifi_files_json_escape(g_wf.ssid, esc, sizeof(esc));
    put(snprintf(chunk, sizeof(chunk),
                 "{\"ssid\":\"%s\",\"truncated\":%s,\"total\":%u,\"files\":[",
                 esc, files.truncated ? "true" : "false", (unsigned)files.total_found));
    for(size_t i = 0; i < files.count; i++) {
        wifi_files_json_escape(files.items[i].name, esc, sizeof(esc));
        put(snprintf(chunk, sizeof(chunk), "%s{\"name\":\"%s\",\"size\":%lu}",
                     i ? "," : "", esc, (unsigned long)files.items[i].size));
    }
    put(snprintf(chunk, sizeof(chunk), "]}"));
    return len;
}

static void handle_api_files(void) {
    CsvFileList files;
    scan_csv_dir(&files, MAX_LIST_FILES);
    if(!files.alloc_ok) {
        g_wf.server->send(503, "application/json", "{\"error\":\"Low memory\"}");
        return;
    }
    g_wf.dirty = true;

    // Built in one buffer (about 60 bytes a file, ~15 KB at the 256-file cap)
    // so it goes out through the Esc-aware writer in one go.
    size_t len = format_files_json(files, nullptr);
    char* body = new (std::nothrow) char[len + 1];
    if(!body) {
        g_wf.server->send(503, "application/json", "{\"error\":\"Low memory\"}");
        return;
    }
    format_files_json(files, body);
    send_body_own_writer("application/json; charset=utf-8", body, len);
    delete[] body;
}

static bool write_client_chunk(void* ctx, const uint8_t* data, size_t len) {
    return client_write_all(*static_cast<NetworkClient*>(ctx), data, len);
}

static void single_progress(void* ctx, uint32_t done) {
    uint32_t total = *static_cast<uint32_t*>(ctx);
    unsigned pct = total ? (unsigned)(((uint64_t)done * 100ULL) / total) : 100u;
    char msg[32];
    snprintf(msg, sizeof(msg), "Sending %u%%", pct);
    update_transfer_ui(msg, false);
}

static void handle_download_single(void) {
    if(!sd_card_ready() || !g_wf.io_buf) {
        g_wf.server->send(503, "text/plain", "SD card unavailable");
        return;
    }
    String name_str = g_wf.server->arg("name");
    char full[128];
    if(!build_csv_path(name_str.c_str(), full, sizeof(full))) {
        g_wf.server->send(400, "text/plain", "Invalid filename");
        return;
    }

    struct stat st;
    if(stat(full, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size < 0 ||
       (uint64_t)st.st_size > 0x7FFFFFFFULL) {
        g_wf.server->send(404, "text/plain", "File not found");
        return;
    }
    uint32_t total = (uint32_t)st.st_size;

    int fd = open(full, O_RDONLY);
    if(fd < 0) {
        g_wf.server->send(500, "text/plain", "Could not open file");
        return;
    }

    send_attachment_headers(name_str.c_str(), "text/csv; charset=utf-8", total);
    g_wf.last_progress_draw_ms = 0;
    update_transfer_ui("Sending 0%", true);

    NetworkClient client = g_wf.server->client();
    bool ok = stream_fd_exact(fd, total, write_client_chunk, &client, single_progress, &total);
    close(fd);

    if(!ok) {
        client.stop();
        Serial.printf("[WiFi] download stopped: %s\n", name_str.c_str());
        set_flash_status(g_wf.wants_exit ? "" : "Download stopped", TFT_RED);
    } else {
        Serial.printf("[WiFi] sent %s (%lu bytes)\n", name_str.c_str(), (unsigned long)total);
        set_flash_status("Sent file", TFT_GREEN);
    }
}

static bool write_zip_chunk(void* ctx, const uint8_t* data, size_t len) {
    return zip_stream_write_data(static_cast<ZipStream*>(ctx), data, len);
}

struct ZipProgCtx {
    ZipStream* zs;
    uint64_t   total_zip;
    size_t     file_num;
    size_t     total_files;
};

static void zip_progress(void* ctx, uint32_t done) {
    (void)done;
    auto* p = static_cast<ZipProgCtx*>(ctx);
    unsigned pct = p->total_zip
        ? (unsigned)(((uint64_t)p->zs->bytes_written * 100ULL) / p->total_zip)
        : 100u;
    char msg[36];
    snprintf(msg, sizeof(msg), "ZIP %u/%u (%u%%)",
             (unsigned)p->file_num, (unsigned)p->total_files, pct);
    update_transfer_ui(msg, false);
}

static void handle_download_all_zip(void) {
    if(!sd_card_ready() || !g_wf.io_buf) {
        g_wf.server->send(503, "text/plain", "SD card unavailable");
        return;
    }

    // No cap here: "Download All" must really include every recording. Each
    // file costs sizeof(ZipStreamEntry) (~80 bytes) of RAM for the ZIP's
    // closing file index.
    CsvFileList files;
    scan_csv_dir(&files, SIZE_MAX);
    if(!files.alloc_ok) {
        g_wf.server->send(503, "text/plain",
                          "Not enough memory to ZIP this many files. "
                          "Download them one by one or delete some old recordings.");
        return;
    }
    if(files.truncated) {
        g_wf.server->send(503, "text/plain", "File list changed, please try again.");
        return;
    }
    if(files.count == 0) {
        g_wf.server->send(404, "text/plain", "No CSV files to download");
        return;
    }

    uint64_t total_zip = zip_stream_calc_total_size(files.items, files.count);
    if(!zip_stream_fits_zip32(total_zip, files.count)) {
        g_wf.server->send(413, "text/plain", "Archive exceeds 2 GB ZIP limit");
        return;
    }

    char zip_name[48];
    if(clock_cardputer_is_set()) {
        SessionDateTime now;
        clock_cardputer_now(&now);
        snprintf(zip_name, sizeof(zip_name), "biomapping_%04u-%02u-%02u.zip",
                 now.year, now.month, now.day);
    } else {
        snprintf(zip_name, sizeof(zip_name), "biomapping_walks.zip");
    }

    send_attachment_headers(zip_name, "application/zip", (uint32_t)total_zip);
    g_wf.last_progress_draw_ms = 0;
    update_transfer_ui("Preparing ZIP...", true);

    NetworkClient client = g_wf.server->client();
    ZipStream zs;
    zip_stream_init(&zs, write_client_chunk, &client, files.items, files.count);

    bool ok = true;
    for(size_t i = 0; i < files.count && ok; i++) {
        char fname[WIFI_FILES_MAX_NAME];
        strncpy(fname, files.items[i].name, sizeof(fname) - 1);
        fname[sizeof(fname) - 1] = '\0';
        uint32_t fsize = files.items[i].size;
        uint16_t fdate = files.items[i].dos_date;
        uint16_t ftime = files.items[i].dos_time;

        char full[128];
        if(!build_csv_path(fname, full, sizeof(full))) {
            ok = false;
            break;
        }
        int fd = open(full, O_RDONLY);
        if(fd < 0) {
            ok = false;
            break;
        }

        ZipProgCtx pctx = {&zs, total_zip, i + 1, files.count};
        ok = zip_stream_begin_file(&zs, fname, fsize, fdate, ftime) &&
             stream_fd_exact(fd, fsize, write_zip_chunk, &zs, zip_progress, &pctx) &&
             zip_stream_end_file(&zs);
        close(fd);
    }

    if(ok && !zip_stream_finish(&zs)) ok = false;

    if(!ok) {
        client.stop();
        Serial.printf("[WiFi] ZIP stopped (%lu/%lu bytes)\n",
                      (unsigned long)zs.bytes_written, (unsigned long)total_zip);
        set_flash_status(g_wf.wants_exit ? "" : "ZIP stopped", TFT_RED);
    } else {
        Serial.printf("[WiFi] sent %s (%u files, %lu bytes)\n",
                      zip_name, (unsigned)files.count, (unsigned long)zs.bytes_written);
        set_flash_status("Sent ZIP", TFT_GREEN);
    }
}

static void handle_delete(void) {
    if(!sd_card_ready()) {
        g_wf.server->send(503, "application/json", "{\"error\":\"SD card unavailable\"}");
        return;
    }
    String name_str = g_wf.server->arg("name");
    char full[128];
    if(!build_csv_path(name_str.c_str(), full, sizeof(full))) {
        g_wf.server->send(400, "application/json", "{\"error\":\"Invalid filename\"}");
        return;
    }

    if(unlink(full) != 0) {
        int code = (errno == ENOENT) ? 404 : 500;
        g_wf.server->send(code, "application/json", "{\"error\":\"Delete failed\"}");
        return;
    }

    scan_csv_dir(nullptr, 0);
    set_flash_status("Deleted 1 file", TFT_GREEN);
    Serial.printf("[WiFi] deleted %s\n", name_str.c_str());
    g_wf.server->sendHeader("Cache-Control", "no-store");
    g_wf.server->send(200, "application/json", "{\"ok\":true}");
}

// Deletes every recording on the card. The names are collected first,
// then removed, so the folder isn't changed while it is being read.
static void handle_delete_all(void) {
    if(!sd_card_ready()) {
        g_wf.server->send(503, "application/json", "{\"error\":\"SD card unavailable\"}");
        return;
    }
    CsvFileList files;
    scan_csv_dir(&files, SIZE_MAX);
    if(!files.alloc_ok) {
        g_wf.server->send(503, "application/json", "{\"error\":\"Low memory\"}");
        return;
    }

    unsigned deleted = 0, failed = 0;
    for(size_t i = 0; i < files.count; i++) {
        char full[128];
        if(build_csv_path(files.items[i].name, full, sizeof(full)) && unlink(full) == 0) {
            deleted++;
        } else {
            failed++;
        }
        yield();
    }

    scan_csv_dir(nullptr, 0);
    char msg[32];
    snprintf(msg, sizeof(msg), "Deleted %u file%s", deleted, deleted == 1 ? "" : "s");
    set_flash_status(msg, failed ? TFT_RED : TFT_GREEN);
    Serial.printf("[WiFi] delete all: %u deleted, %u failed\n", deleted, failed);

    char body[64];
    snprintf(body, sizeof(body), "{\"ok\":true,\"deleted\":%u,\"failed\":%u}", deleted, failed);
    g_wf.server->sendHeader("Cache-Control", "no-store");
    g_wf.server->send(200, "application/json", body);
}

// The "continue in Safari" page, reached from Download in Apple's sign-in
// window. From now on this device's sign-in check is answered "Success"
// (handle_not_found()), so the window's Cancel turns into Done; loading this
// page is what makes the window check again. %s: our address, then the
// hotspot name. No other '%' in it: it is a printf format.
static const char BROWSER_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Continue in Safari</title>
<style>
body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1321;color:#e8eef7;line-height:1.5}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:1.3rem;margin:0 0 12px;color:#fff}
li{margin-bottom:8px}
.addr{font-size:1.4rem;font-weight:700;color:#7dd3fc;margin:6px 0 16px;-webkit-user-select:all;user-select:all}
.small{font-size:.85rem;color:#93a8c9}
a{color:#7dd3fc}
</style>
</head>
<body>
<div class="wrap">
<h1>Continue in Safari</h1>
<p>This Wi-Fi sign-in window can't save files. Safari, or any other browser, can, and you stay on the Cardputer's Wi-Fi.</p>
<ol>
<li>Click <b>Done</b> in this window. If it still says Cancel, wait a few seconds.</li>
<li>Open Safari and go to:</li>
</ol>
<div class="addr">%s</div>
<p class="small">If Done never shows, click Cancel. If your Mac then leaves the Wi-Fi, join <b>%s</b> again: this window won't open again, so go straight to the address in Safari.</p>
<p class="small">Already in a browser? <a href="/">Back to the files</a></p>
</div>
</body>
</html>
)HTML";

static void handle_browser(void) {
    IPAddress ip = g_wf.server->client().remoteIP();
    wifi_files_released_add(&g_released, (uint32_t)ip);
    Serial.printf("[WiFi] %s continues in a browser\n", ip.toString().c_str());

    static char page[sizeof(BROWSER_HTML) + sizeof(g_wf.qr_url) + sizeof(g_wf.ssid)];
    int n = snprintf(page, sizeof(page), BROWSER_HTML, g_wf.qr_url, g_wf.ssid);
    if(n < 0 || (size_t)n >= sizeof(page)) {
        g_wf.server->send(500, "text/plain", "Page too long");
        return;
    }
    send_body_own_writer("text/html; charset=utf-8", page, (size_t)n);
}

// Every unknown address, including the phone's "am I online?" checks
// (Android's /generate_204, Apple's /hotspot-detect.html, Windows'
// /connecttest.txt), is redirected to the file page. Because the DNS server
// answers every name with our address, the phone sees a sign-in page and pops
// it up by itself on joining. The exception: Apple's check from a device
// that chose to continue in Safari (handle_browser()) gets Apple's
// "Success", so its sign-in window can close with Done.
static void handle_not_found(void) {
    if(wifi_files_is_apple_probe(g_wf.server->uri().c_str()) &&
       wifi_files_released_has(&g_released, (uint32_t)g_wf.server->client().remoteIP())) {
        g_wf.server->sendHeader("Cache-Control", "no-store");
        g_wf.server->send(200, "text/html", WIFI_FILES_APPLE_SUCCESS_HTML);
        return;
    }
    char loc[sizeof(g_wf.qr_url) + 1];
    snprintf(loc, sizeof(loc), "%s/", g_wf.qr_url);
    g_wf.server->sendHeader("Location", loc, true);
    g_wf.server->sendHeader("Cache-Control", "no-store");
    g_wf.server->send(302, "text/plain", "");
}

// ── Public lifecycle, polling, keys, and drawing ─────────────────────────

bool wifi_files_start(M5Canvas& canvas) {
    wifi_files_stop();
    if(!sd_card_mount() || !sd_card_ready()) {
        Serial.println("[WiFi] warning: SD card not ready");
        return false;
    }

    g_wf.io_buf = new (std::nothrow) uint8_t[IO_BUF_BYTES];
    if(!g_wf.io_buf) {
        Serial.println("[WiFi] warning: could not allocate I/O buffer");
        wifi_files_stop();
        return false;
    }

    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    wifi_files_format_ssid(mac, g_wf.ssid, sizeof(g_wf.ssid));

    WiFi.persistent(false);
    if(!WiFi.mode(WIFI_AP)) {
        Serial.println("[WiFi] warning: failed to start hotspot");
        wifi_files_stop();
        return false;
    }
    // Open hotspot: no password, so anyone in range can join and use the page.
    wifi_files_format_wifi_qr(g_wf.ssid, NULL, g_wf.qr_wifi, sizeof(g_wf.qr_wifi));

    if(!WiFi.softAP(g_wf.ssid)) {
        Serial.println("[WiFi] warning: failed to start hotspot");
        wifi_files_stop();
        return false;
    }
    WiFi.setTxPower(WIFI_POWER_15dBm);

    IPAddress ip = WiFi.softAPIP();
    snprintf(g_wf.qr_url, sizeof(g_wf.qr_url), "http://%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);

    g_wf.server = new (std::nothrow) WebServer(80);
    if(!g_wf.server) {
        Serial.println("[WiFi] warning: could not allocate WebServer");
        wifi_files_stop();
        return false;
    }

    g_wf.server->on("/", HTTP_GET, handle_index);
    g_wf.server->on("/favicon.ico", HTTP_GET, handle_no_content);
    g_wf.server->on("/apple-touch-icon.png", HTTP_GET, handle_no_content);
    g_wf.server->on("/apple-touch-icon-precomposed.png", HTTP_GET, handle_no_content);
    g_wf.server->on("/api/files", HTTP_GET, handle_api_files);
    g_wf.server->on("/download", HTTP_GET, handle_download_single);
    g_wf.server->on("/download-all.zip", HTTP_GET, handle_download_all_zip);
    g_wf.server->on("/api/delete", HTTP_POST, handle_delete);
    g_wf.server->on("/api/delete-all", HTTP_POST, handle_delete_all);
    g_wf.server->on("/browser", HTTP_GET, handle_browser);
    g_wf.server->onNotFound(handle_not_found);
    g_wf.server->begin();

    // Answer every DNS name with our address so phones pop up the page.
    // Not fatal if it fails: the page still works at the typed address.
    g_wf.dns = new (std::nothrow) DNSServer();
    if(!g_wf.dns || !g_wf.dns->start(53, "*", ip)) {
        Serial.println("[WiFi] warning: DNS server did not start (no pop-up page)");
        delete g_wf.dns;
        g_wf.dns = nullptr;
    }

    g_wf.canvas = &canvas;
    g_wf.active = true;
    g_wf.wants_exit = false;
    g_wf.show_url_qr = false;
    g_wf.manual_qr = false;
    g_wf.dirty = false;
    g_wf.status_line[0] = '\0';
    g_wf.status_timed = false;
    g_wf.client_count = 0;
    scan_csv_dir(nullptr, 0);
    g_wf.last_client_poll_ms = millis();
    g_wf.idle_since_ms = g_wf.last_client_poll_ms;
    g_wf.idle_mins_shown = IDLE_OFF_MS / 60000UL;

    // Ensure the QR code is bright enough for phone cameras even when DIM.
    M5Cardputer.Display.setBrightness(QR_BRIGHTNESS);

    Serial.printf("[WiFi] on: ap=%s ip=%u.%u.%u.%u files=%d (free heap %u)\n",
                  g_wf.ssid, ip[0], ip[1], ip[2], ip[3],
                  g_wf.file_count, (unsigned)ESP.getFreeHeap());
    return true;
}

void wifi_files_stop(void) {
    bool was_active = g_wf.active || g_wf.server != nullptr || WiFi.getMode() != WIFI_OFF;
    if(g_wf.dns) {
        g_wf.dns->stop();
        delete g_wf.dns;
        g_wf.dns = nullptr;
    }
    if(g_wf.server) {
        g_wf.server->stop();
        delete g_wf.server;
        g_wf.server = nullptr;
    }
    delete[] g_wf.io_buf;
    g_wf.io_buf = nullptr;
    wifi_files_released_clear(&g_released);  // next time, every device gets the pop-up again

    g_wf.active = false;
    g_wf.wants_exit = false;
    g_wf.status_timed = false;
    g_wf.canvas = nullptr;
    g_wf.client_count = 0;
    g_wf.qr_wifi[0] = '\0';

    if(was_active) {
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_OFF);
        settings_cardputer_apply_backlight();
        Serial.printf("[WiFi] off (free heap %u)\n", (unsigned)ESP.getFreeHeap());
    }
}

bool wifi_files_active(void) {
    return g_wf.active;
}

int wifi_files_client_count(void) {
    return g_wf.client_count;
}

bool wifi_files_wants_exit(void) {
    return g_wf.wants_exit;
}

bool wifi_files_poll(M5Canvas& canvas) {
    if(!g_wf.active || !g_wf.server) return false;
    g_wf.canvas = &canvas;

    g_wf.server->handleClient();

    bool redraw = g_wf.dirty;
    g_wf.dirty = false;

    uint32_t now = millis();
    if(g_wf.status_timed && now - g_wf.status_since_ms >= STATUS_FLASH_MS) {
        g_wf.status_line[0] = '\0';
        g_wf.status_timed = false;
        redraw = true;
    }

    if(now - g_wf.last_client_poll_ms >= CLIENT_POLL_MS) {
        g_wf.last_client_poll_ms = now;
        int clients = (int)WiFi.softAPgetStationNum();
        if(clients != g_wf.client_count) {
            int prev = g_wf.client_count;
            g_wf.client_count = clients;
            if(!g_wf.manual_qr) {
                if(prev == 0 && clients > 0) {
                    g_wf.show_url_qr = true;
                    cues_cardputer_play(g_settings.sound_enabled, BioMapCueClick);
                } else if(prev > 0 && clients == 0) {
                    g_wf.show_url_qr = false;
                }
            }
            if(clients == 0) g_wf.idle_since_ms = now;
            redraw = true;
        }
    }

    // Auto-off: with no device connected for IDLE_OFF_MS, close the screen so
    // a forgotten hotspot doesn't drain the battery.
    if(g_wf.client_count == 0) {
        uint32_t idle = now - g_wf.idle_since_ms;
        if(idle >= IDLE_OFF_MS) {
            Serial.println("[WiFi] no device for 10 min, turning off");
            g_wf.wants_exit = true;
            return true;
        }
        uint32_t mins_left = (IDLE_OFF_MS - idle + 59999UL) / 60000UL;
        if(mins_left != g_wf.idle_mins_shown) {
            g_wf.idle_mins_shown = mins_left;
            redraw = true;
        }
    }
    return redraw;
}

bool wifi_files_key(SessionKey key) {
    if(!g_wf.active) return false;
    if(key == SessionKeyLeft || key == SessionKeyRight || key == SessionKeyOk) {
        g_wf.show_url_qr = !g_wf.show_url_qr;
        g_wf.manual_qr = true;
        cues_cardputer_play(g_settings.sound_enabled, BioMapCueClick);
        return true;
    }
    return false;
}

void wifi_files_draw(M5Canvas& canvas) {
    // Left: QR code as tall as the screen. No 4-module margin is forced, so
    // the modules are as big as possible; the white square still leaves a
    // quiet zone of a couple of modules round the code.
    const char* payload = g_wf.show_url_qr ? g_wf.qr_url : g_wf.qr_wifi;
    canvas.qrcode(payload, 0, 0, QR_SIZE, 1, false);

    // Right: what to do, then live status.
    if(!g_wf.show_url_qr) {
        draw_fit(canvas, "1. Join Wi-Fi", 2, TFT_CYAN);
        draw_fit(canvas, g_wf.ssid, 20, TFT_WHITE);
        draw_fit(canvas, "No password", 40, COL_MUTED);
    } else {
        draw_fit(canvas, "2. Open page", 2, TFT_CYAN);
        const char* host = strncmp(g_wf.qr_url, "http://", 7) == 0 ? g_wf.qr_url + 7 : g_wf.qr_url;
        draw_fit(canvas, host, 20, TFT_WHITE);
        draw_fit(canvas, g_wf.ssid, 40, COL_MUTED);
    }

    char line[24];
    if(g_wf.client_count > 0) {
        snprintf(line, sizeof(line), "%d %s",
                 g_wf.client_count, g_wf.client_count == 1 ? "device" : "devices");
        draw_fit(canvas, line, 78, TFT_GREEN);
    } else {
        snprintf(line, sizeof(line), "Off in %lu min", (unsigned long)g_wf.idle_mins_shown);
        draw_fit(canvas, line, 78, COL_MUTED);
    }

    draw_status_line(canvas);

    canvas.setFont(&fonts::Font0);
    canvas.setTextColor(COL_MUTED);
    canvas.drawString("<> QR  Esc stop", PANEL_X, SCREEN_H - 10);
    canvas.setFont(&fonts::Font2);
}
