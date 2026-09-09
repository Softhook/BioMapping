# Proposal: Voice Annotations for Peaks

**Status:** proposal / scoping — nothing built. 2026-09-09.

This document proposes how a user could record a spoken note against an
individual SCR peak in the visualiser, have it transcribed to text, and have
both the transcript and (optionally) the audio persist and travel with the
recording. It weighs the storage question the feature turns on — **does the
audio go "straight to a server", or does the user record and then download a
file?** — and recommends a phased path.

---

## 1. What exists today

The visualiser already has a **text** peak-annotation system. Voice annotation
is an extension of it, and the existing design constrains the options.

| Concern | How it works now | Reference |
|---|---|---|
| Peak identity | Peaks are **re-detected from scratch** on every slider move. They have **no stable ID** — they are identified by timestamp. | `analyzer.analyze()` |
| Label storage (in memory) | `analyzer._userPeakLabels` — a `Map<time(sec, 3 dp) → string>`. After each re-analysis, `_assignLabelsToPeaks()` re-matches labels to fresh peaks by timestamp (±1.0 s, optimal 1-to-1). | `visualiser/src/signal/analyzer.js:59`, `:163`, `:218` |
| Label editing | Three surfaces, all routed through `GSRUI.updatePeakLabel(idx, label, trackId)` / `handleLiveLabelInput`: 2D map popup, peaks table, 3D globe edit card. | `visualiser/src/map/map_popups.js:110`, `visualiser/src/ui/ui.js:469`, `globe3d_view._editPeakLabel` |
| Label persistence (on disk) | Written as a `PeakLabel` **column in the processed CSV** — one text value on the peak's sample row. Re-import reads a `peaklabel` / `peak_label` header. | `analyzer.js:2075`, `:2114`; `visualiser/src/signal/csv_parser.js:438` |
| Multi-track project | A JSZip **`.zip`** bundling one processed CSV per track + `manifest.json`. Labels ride inside each CSV. | `visualiser/src/spatial/collective_project.js` |
| Dirty tracking | `track.hasUnsavedLabels` / `_markUnsavedLabels`. | `ui.js:63` |
| Audio | **None anywhere in the codebase.** | — |
| Binary-blob storage | IndexedDB, with a clean promise-wrapper pattern already in use for the Overpass cache. | `visualiser/src/osm/osm_cache.js` |
| File saving | `GSRFileSaver.saveFile` — File System Access API with a download fallback. | `visualiser/src/core/file_saver.js` |

### 1.1 The deployment reality

The visualiser is **100 % static client-side code, no server, no build step**
(`README.md` §"The Visualiser"), served from **GitHub Pages**
(`<user>.github.io/BioMapping/…`). GitHub Pages is **read-only hosting** — a
page served from it cannot receive an upload. "Save straight to the GitHub
server" is therefore **not possible without adding infrastructure**: either the
browser talks to the GitHub API directly with a credential, or a small
serverless function does it on the user's behalf, or the data goes to
third-party object storage. Section 4 lays out each path.

---

## 2. The feature has three separable parts

1. **Capture** — record microphone audio against a peak. (Section 3.1)
2. **Transcription** — turn that audio into a text string. (Section 3.2)
3. **Persistence** — where the transcript and/or audio live, and how they
   travel with the recording. (Section 4 — the crux.)

A key realisation that shapes everything: **if the audio is treated as
transient** — recorded, transcribed, and then discarded — then only text needs
to persist, and the *existing* `PeakLabel` mechanism already handles that with
zero new storage work. The audio-retention question is what forces the
infrastructure decision. The proposals below are tiered on exactly that.

---

## 3. Capture and transcription

### 3.1 Capture — `MediaRecorder`

* `navigator.mediaDevices.getUserMedia({ audio: true })` → `MediaRecorder`.
  Supported in Chrome, Edge, Firefox, and Safari 14.1+.
* Codec via `MediaRecorder.isTypeSupported()`: `audio/webm;codecs=opus`
  (Chromium/Firefox) or `audio/mp4` (Safari). Opus ≈ 8–16 KB/s, so a 20-second
  note ≈ **200–400 KB**.
* One-time microphone-permission prompt per origin. Needs graceful
  handling of *denied* / *no device* (same resilience posture as
  `osm_cache.js` under private browsing).
* **Duration cap** (proposed 60 s) and a per-track **count cap** to bound
  storage.
* **UI** — a record / stop / play / delete control added to **all three**
  existing edit surfaces (map popup, peaks table, globe card), so voice behaves
  consistently with text labels. Recording state machine: `idle → recording →
  has-clip`. Elapsed-seconds counter (a live waveform is a nice-to-have, not
  needed for v1).
* A **🎤 badge** on peaks that carry a note, in the p5 graph and on map
  markers — parallels the existing label-chip logic at
  `map_manager_peaks.js:44`.

### 3.2 Transcription — three options

| Option | Where it runs | Cost / infra | Accuracy | Offline | Notes |
|---|---|---|---|---|---|
| **A. Web Speech API** (`SpeechRecognition`) | Browser, but Chrome streams audio to Google servers under the hood | None (no key) | Good for clear speech | ❌ (Chrome) | Zero-cost, near-instant, **live interim results** while speaking. Not in Firefox; Safari support partial. Implicit third-party audio transmission — worth disclosing. |
| **B. Whisper WASM** (`whisper.cpp` / `transformers.js`, `whisper-tiny`/`base`) | Fully in-browser, on-device | ~30–75 MB model download (cache in IndexedDB / Cache API), CPU-heavy | Very good even for `base` | ✅ | True privacy, no network. First use downloads the model; transcription of a 20 s clip ≈ a few seconds on a laptop. Heaviest engineering. |
| **C. Cloud STT API** (OpenAI Whisper API, Deepgram, Google STT) | Remote | API key + **a proxy** (a key cannot ship in a static page) — same serverless piece as §4.3 | Best | ❌ | Only sensible if a serverless component already exists for audio upload; then transcription is a cheap add-on to that endpoint. |

**Recommendation:** ship **A (Web Speech API)** first — it is free, needs no
infrastructure, and gives live feedback as the user talks; the transcript lands
in the same field a typed label would. Offer **B (Whisper WASM)** later as a
privacy-preserving / offline toggle. Reserve **C** for the case where §4.3's
serverless upload is built anyway.

In every case the transcript is **editable** after the fact — it pre-fills the
existing label field; the user can correct it. The audio (if retained) stays
attached as evidence.

---

## 4. Persistence — the storage question

Four tiers, cheapest first. They are additive: each builds on the previous.

### 4.0 Tier 0 — Transcript only, no audio retained *(recommended first step)*

Record → transcribe (§3.2 A) → **discard the audio**. Only the text persists.

* **Storage:** none new. The transcript flows into `analyzer._userPeakLabels`
  and out through the existing `PeakLabel` CSV column and the project `.zip`,
  exactly as a typed label does today.
* **"Server vs download":** moot — there is nothing binary to store.
* **Effort:** ~2 days (capture UI on the three surfaces + Web Speech wiring +
  a "dictate" button that writes into the label field).
* **Limitation:** no audio to re-listen to; you trust the transcript. Tone,
  hesitation, ambient sound are lost.

This alone may satisfy the use case ("I want to say a note instead of typing
it while walking").

### 4.1 Tier 1 — Audio retained locally + bundled into the downloadable project

Keep the audio. It lives **on the user's machine** and travels only inside the
project file they explicitly save. **No server.**

* **Working store:** a new IndexedDB object store `peakVoiceNotes`, keyed
  `[trackId, peakTimeKey]`, value `{ blob, mime, durationSec, transcript,
  createdAt }`. Copy the promise-wrapper and private-browsing resilience from
  `osm_cache.js`.
* **In-memory model:** `analyzer._userPeakVoiceNotes` — a `Map` parallel to
  `_userPeakLabels`, with `setPeakVoiceNote(time, note)` /
  `getMatchingVoiceNote(time, tol)` / `_assignVoiceNotesToPeaks()`. These are a
  near-mechanical clone of the label methods (`analyzer.js:163`–`260`).
  `_dataVersion++` on change; the transcript field also mirrors into
  `_userPeakLabels` so existing label rendering "just works".
* **Portable format:** extend the project `.zip`
  (`collective_project.js:138`): add `audio/<trackId>/<peakTimeKey>.webm`
  files and a sidecar `voice_notes.json`
  (`[{ trackId, time, file, mime, durationSec, transcript }]`). Import
  (`collective_project.js:238` loop) gains an audio-restore step feeding
  `analyzer.setPeakVoiceNote`.
* **Single-track CSV export** keeps **transcript only** (the `PeakLabel`
  column, or a dedicated `PeakVoiceTranscript` column). Audio requires "Save as
  Project". Document this clearly.
* **Lifecycle:** revoke `URL.createObjectURL` on popup close; delete button per
  note; orphan-cleanup when a track is removed (`tracks.js`); a real "clear
  voice notes" that empties the object store; a storage-usage readout.
* **Effort:** ~1 week on top of Tier 0.
* **Answer to the question:** this is the **"record then download"** model —
  simplest, no accounts, no keys, no backend, works offline. The audio is as
  portable as the project file.

### 4.2 Tier 2a — Commit straight to the GitHub repo from the browser

The page calls the **GitHub REST API** (`PUT /repos/{owner}/{repo}/contents/
{path}`) to commit each audio file, e.g. under `tracks/voice/<track>/<time>.webm`.

* **Credential:** the browser needs a token with write scope. Options, all with
  friction:
  * **Fine-grained Personal Access Token** pasted by the user into a settings
    field (stored in `localStorage`). Simple to build; the user is trusting the
    page with a repo-write token, and it is one user only.
  * **GitHub App + OAuth device flow** — proper, revocable, per-user, but needs
    an OAuth client and still a tiny token-exchange endpoint (a static page
    cannot hold the client secret). At that point §4.3 is the cleaner shape.
* **Binary in git:** `.webm` blobs in repo history bloat every clone forever.
  Requires **Git LFS** (`.gitattributes`: `*.webm filter=lfs`) — adds an LFS
  quota and a checkout dependency. The repo currently tracks **no** binaries and
  the `tracks/` folder is **not** version-controlled at all, so this is a real
  policy change.
* **Concurrency / review:** direct commits to `main` from a web page bypass PR
  review and can race. Committing to a branch + opening a PR is friendlier but
  more code.
* **Effort:** ~3–5 days on top of Tier 1 (token UI, GitHub API client, LFS
  setup, error/rate-limit handling), plus the ongoing repo-bloat cost.
* **Verdict:** works for a **single trusted maintainer**, poor fit for multiple
  contributors or for keeping the repo clean. Only attractive because it needs
  no server *you* run.

### 4.3 Tier 2b — Small serverless upload endpoint *(recommended if audio must be centralised)*

A single function on **Cloudflare Workers / Netlify / Vercel** (free tiers cover
this easily) that the page `POST`s audio to. The function holds the secret and
does one of:

* commits the file to the repo via the GitHub API (server-side token, Git LFS
  as in §4.2), **or**
* writes it to **object storage** — Cloudflare R2 / Backblaze B2 / S3 —
  and returns a URL. `voice_notes.json` (in the project zip and/or a small
  index file) stores the URLs. This keeps binaries **out of git entirely**.

Add-ons this endpoint makes cheap:

* **Server-side transcription** (§3.2 C) in the same request — audio in,
  `{ url, transcript }` out.
* **Auth** — a shared token, Cloudflare Access, or GitHub OAuth, depending on
  who should be allowed to upload.

* **Effort:** ~3–4 days on top of Tier 1 (worker + storage bucket + client
  upload/retry + config), minimal ongoing cost, no repo bloat.
* **Verdict:** the **cleanest "straight to a server"** answer. The static site
  stays static; one tiny function is the only new moving part; audio lives in
  storage built for blobs, not in git.

### 4.4 Tier 3 — Backend-as-a-service (Supabase / Firebase)

Managed Postgres/Storage + auth + client SDK. Voice notes become rows with a
storage reference; multi-user, live-syncing, queryable.

* **Effort:** ~1–2 weeks; introduces an account model and a hosted dependency
  the project has so far avoided.
* **Verdict:** overkill unless BioMapping is heading toward multi-user shared
  projects generally — in which case voice notes ride along for free.

### 4.5 Comparison

| | Infra to run | Audio travels with file | Audio centralised | Repo stays clean | Offline | Effort (on top of Tier 0) |
|---|---|---|---|---|---|---|
| **T0** transcript only | none | ✅ (text) | n/a | ✅ | ✅ | — |
| **T1** local + project zip | none | ✅ (in zip) | ❌ | ✅ | ✅ | ~1 wk |
| **T2a** browser → GitHub | none¹ | ✅ | ✅ (in repo) | ❌ (LFS, bloat) | ❌ | +3–5 d |
| **T2b** serverless endpoint | 1 function | ✅ | ✅ (R2/S3) | ✅ | ❌ | +3–4 d |
| **T3** Supabase/Firebase | hosted BaaS | ✅ | ✅ | ✅ | ❌ | +1–2 wk |

¹ still needs a user-supplied token or an OAuth exchange endpoint.

---

## 5. Recommended path

1. **Tier 0 now** — spoken notes transcribed into the existing label field via
   the Web Speech API. Small, self-contained, no storage or infra changes.
   Validates the interaction.
2. **Tier 1 next, if re-listening matters** — retain audio in IndexedDB and in
   the downloadable project `.zip`. This is the **"record then download"**
   model and needs no backend.
3. **Tier 2b only if audio must be centralised / shared** — one serverless
   function writing to object storage (not git), optionally doing server-side
   Whisper transcription in the same call.

Avoid Tier 2a (browser-commits-to-repo) unless BioMapping stays a
single-maintainer project and repo bloat via LFS is acceptable.

---

## 6. Data-model & schema changes (Tier 1+)

* **`analyzer._userPeakVoiceNotes`** — `Map<timeKey → { mime, durationSec,
  transcript, createdAt, blobRef }>`, where `blobRef` is an IndexedDB key (or a
  URL in Tier 2). Re-matched to peaks on every `analyze()` by the existing
  optimal-timestamp-assignment routine.
* **`peak` object** gains `voiceNote` (a reference, not the blob) alongside the
  current `label`.
* **Processed CSV** — new column `PeakVoiceTranscript` (text; parallels
  `PeakLabel`). Optionally `PeakVoiceRef` (zip path or URL). Bump the processed
  CSV's schema note; parser gains `peakvoicetranscript` header detection
  (`csv_parser.js:438` neighbourhood).
* **Project `.zip`** — `audio/` folder + `voice_notes.json` sidecar; manifest
  version bump; import restore step.
* **Dirty flag** — `hasUnsavedLabels` extended (or `hasUnsavedVoiceNotes`
  added) so the unsaved-changes guard fires.

---

## 7. UI changes

* Record/stop/play/delete + transcript textarea in: **map popup**
  (`map_popups.js buildPeakPopup`), **peaks table row** (`ui.js:469`), **globe
  edit card** (`globe3d_view._editPeakLabel`).
* 🎤 indicator on annotated peaks in the p5 graph and map markers.
* Settings: microphone device picker (optional), transcription-engine toggle
  (Web Speech / Whisper / off), storage-usage readout, "clear all voice notes".
* Privacy notice: voice is personal data; the Web Speech API transmits audio to
  a third party in Chrome; a project `.zip` now contains recordings of a
  person's voice.

---

## 8. Testing

* **Analyzer store** — set/get/nearest-match/survives-re-analysis for
  `_userPeakVoiceNotes`; clone the existing label tests.
* **Project round-trip** — export/import a project with a stub blob; extend the
  existing collective-project export test.
* **CSV** — `PeakVoiceTranscript` write + re-import.
* **Capture** — `MediaRecorder` / `getUserMedia` do not exist in jsdom.
  Put capture behind a thin `VoiceRecorder` wrapper that can be stubbed; unit
  test the state machine with a mock, and cover real recording in
  `tests/manual/`.
* **Transcription** — mock the engine interface; assert the transcript reaches
  the label field and is editable.
* **Tier 2** — mock the upload endpoint; test retry, offline queue, and the
  URL landing in `voice_notes.json`.

---

## 9. Effort summary

| Scope | Estimate |
|---|---|
| Tier 0 (transcribe-to-label) | ~2 days |
| Tier 1 (audio local + project zip) | ~1 week |
| Tier 2b (serverless endpoint + object storage, incl. optional server STT) | +3–4 days |
| Whisper-WASM offline transcription option | +2–3 days |

---

## 10. Open questions

1. Is **Tier 0** (transcript only, audio discarded) enough for the use case, or
   is re-listening to the original audio a hard requirement?
2. If audio is retained: is **"record then download in the project file"**
   (Tier 1) acceptable, or must recordings land somewhere central
   automatically (Tier 2)?
3. If central: is BioMapping willing to run **one serverless function**
   (Tier 2b), or must it stay strictly zero-infrastructure (pushing toward
   Tier 2a + Git LFS, with the repo-bloat cost)?
4. Who may upload — just the maintainer, or any user of the hosted site?
5. Transcription engine preference: free-but-cloud (Web Speech), or
   heavier-but-on-device (Whisper WASM)?
6. Max note length and notes-per-track?
