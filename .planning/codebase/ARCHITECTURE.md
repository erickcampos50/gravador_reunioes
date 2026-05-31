<!-- refreshed: 2026-05-31 -->
# Architecture

**Analysis Date:** 2026-05-31

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         UI Layer (app.js)                                   │
│  DOM bindings · event dispatch · state rendering · device enumeration       │
│  `js/app.js` (2876 lines — orchestrator)                                    │
├──────────────┬──────────────┬───────────────┬───────────────────────────────┤
│ State Machine│ Recorder API │ Transcription │  Media Library                │
│ `recorder-   │ `recorder-   │ Controller    │  `media-library.js`           │
│  state-      │  api.js`     │ `transcription│                               │
│  machine.js` │              │ -controller.js│                               │
├──────────────┴──────────────┴───────────────┴───────────────────────────────┤
│                          Engine Layer                                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐             │
│  │ AudioMixer │ │ Compositor │ │ Metronome  │ │ RecorderCore │             │
│  │`audio-     │ │`compositor │ │`metronome  │ │`recorder-    │             │
│  │ mixer.js`  │ │ .js`       │ │ .js`       │ │ core.js`     │             │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Storage Layer          │  API Clients                                      │
│  `storage.js`           │  `openai-client.js`                               │
│  (FSA + IndexedDB)      │  (OpenAI + AssemblyAI)                            │
├─────────────────────────┴───────────────────────────────────────────────────┤
│  External: Mediabunny (CDN) · ffmpeg.wasm (CDN) · OpenAI API · AssemblyAI  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **app.js** | Orchestration: creates engines, wires UI events, renders state, manages preferences, auth gate, media library UI | `js/app.js` |
| **RecorderStateMachine** | Finite-state machine defining valid states, events, and transitions for the recording lifecycle | `js/recorder-state-machine.js` |
| **RecorderAPI** | Media acquisition (screen/webcam/mic), encoder pipeline init/finalize, stream lifecycle | `js/recorder-api.js` |
| **RecorderCore** | Mediabunny wrapper: canvas frames + audio track → `FileSystemWritableFileStream` via WebCodecs | `js/recorder-core.js` |
| **AudioMixer** | AudioContext graph: mix system audio + mic, gain control, RMS level meters, macOS silent-audio workaround | `js/audio-mixer.js` |
| **Compositor** | Canvas compositing: screen capture + webcam PiP overlay + timestamp; PiP drag-to-reposition | `js/compositor.js` |
| **Metronome** | Web Worker proxy timer for background-safe frame scheduling; rAF for preview, Worker-timed loop for recording | `js/metronome.js` |
| **StorageManager** | File System Access API: directory picker, permission verification, IndexedDB persistence of directory handle | `js/storage.js` |
| **MediaLibrary** | Enumerate media files, locate related transcripts/notes, read/write transcript versions with consistent naming | `js/media-library.js` |
| **OpenAIClientManager** | OpenAI API calls: transcription (`gpt-4o-transcribe`, `whisper-1`) and post-processing (`/v1/responses`) | `js/openai-client.js` |
| **AssemblyAIClientManager** | AssemblyAI API calls: upload → poll → retrieve transcript (Universal models) | `js/openai-client.js` |
| **TranscriptionController** | Live transcript (WAV chunking via ScriptProcessor), file transcription (compression/splitting via ffmpeg.wasm) | `js/transcription-controller.js` |
| **prefs.js** | localStorage key constants and read/write helpers | `js/prefs.js` |
| **dialogs.js** | Alert banner, toast notifications, modal error dialog | `js/dialogs.js` |
| **media-session.js** | Media Session API integration for OS media controls and lock-screen metadata | `js/media-session.js` |
| **analytics.js** | Google Analytics event tracking wrapper (no-op when GA unavailable) | `js/analytics.js` |
| **register-service-worker.js** | PWA service worker registration and in-app update notification bar | `js/register-service-worker.js` |

## Pattern Overview

**Overall:** Layered monolith with dependency injection and finite-state machine coordination.

**Key Characteristics:**
- **No framework, no bundler** — vanilla ES6 modules loaded directly by the browser via `<script type="module">`
- **Dependency injection** — engine instances are created in `js/app.js` and injected into `RecorderAPI` at construction time
- **Finite-state machine** — recording lifecycle is governed by an explicit transition table in `js/recorder-state-machine.js`
- **Private fields throughout** — all modules use `#private` class fields for encapsulation
- **No build step** — source files are served directly; CDN handles third-party dependencies

## Layers

### UI Layer

- **Purpose:** DOM binding, event dispatch, state rendering, user interaction orchestration
- **Location:** `js/app.js`
- **Contains:** DOM element references, event listeners, render functions, auth gate logic, preference management, media library UI
- **Depends on:** All engine modules, state machine, storage, transcription, media library
- **Used by:** `index.html` (loaded as `<script type="module" src="./js/app.js">`)

### State Machine Layer

- **Purpose:** Define valid recording states and transitions; delegate side-effects to RecorderAPI
- **Location:** `js/recorder-state-machine.js`
- **Contains:** `STATE` enum, `EVENT` enum, `TRANSITIONS` table, `RecorderStateMachine` class
- **Depends on:** `RecorderAPI` (injected via constructor)
- **Used by:** `js/app.js` (subscribes to state changes, dispatches events)

### Media/Encoder API Layer

- **Purpose:** Coordinate media stream acquisition, encoder pipeline lifecycle, and session management
- **Location:** `js/recorder-api.js`
- **Contains:** `RecorderAPI` class with `acquireAndInit()`, `startEncoding()`, `pauseEncoding()`, `resumeEncoding()`, `finalizeEncoding()`
- **Depends on:** `Compositor`, `AudioMixer`, `Metronome`, `RecorderCore`, `StorageManager` (all injected)
- **Used by:** `RecorderStateMachine` (effects call API methods), `js/app.js`

### Engine Layer

- **Purpose:** Low-level media processing — audio mixing, canvas compositing, frame timing, encoding
- **Location:** `js/audio-mixer.js`, `js/compositor.js`, `js/metronome.js`, `js/recorder-core.js`
- **Contains:** Self-contained engine classes with no DOM references (except canvases passed in)
- **Depends on:** Browser APIs (Web Audio, Canvas, WebCodecs via Mediabunny, Web Workers)
- **Used by:** `RecorderAPI`

### Storage Layer

- **Purpose:** File system access, directory persistence, text file I/O
- **Location:** `js/storage.js`
- **Contains:** `StorageManager` class, IndexedDB helpers, `dateStamp()` utility
- **Depends on:** File System Access API, IndexedDB
- **Used by:** `RecorderAPI` (file creation), `MediaLibrary` (directory listing, transcript I/O), `js/app.js`

### Transcription Layer

- **Purpose:** Audio-to-text via external APIs, live streaming transcription, file compression/splitting
- **Location:** `js/openai-client.js`, `js/transcription-controller.js`
- **Contains:** `OpenAIClientManager`, `AssemblyAIClientManager`, `TranscriptionController`, `RollingTranscriptionSession`
- **Depends on:** OpenAI API, AssemblyAI API, ffmpeg.wasm (CDN), `MediaLibrary`
- **Used by:** `js/app.js`

### Support Layer

- **Purpose:** Cross-cutting utilities — preferences, dialogs, analytics, PWA registration
- **Location:** `js/prefs.js`, `js/dialogs.js`, `js/analytics.js`, `js/media-session.js`, `js/register-service-worker.js`
- **Contains:** Small focused modules with single responsibilities
- **Depends on:** localStorage, DOM, Google Analytics (optional), Service Worker API
- **Used by:** `js/app.js`

## Data Flow

### Recording Pipeline

1. User clicks "Start Recording" → `app.js` dispatches `EVENT.USER_START` to state machine (`js/app.js:~2831`)
2. State machine transitions to `REQUESTING`, effect calls `api.acquireAndInit(payload)` (`js/recorder-state-machine.js:83`)
3. `RecorderAPI.acquireAndInit()` acquires screen via `getDisplayMedia`, webcam via `getUserMedia`, mic via `getUserMedia` (`js/recorder-api.js:93-148`)
4. `AudioMixer.buildMix()` creates mixed audio track from system + mic sources (`js/recorder-api.js:180`)
5. `StorageManager.ensureAccess()` verifies writable directory, creates output file via `FileSystemWritableFileStream` (`js/recorder-api.js:185-198`)
6. `RecorderCore.init()` builds Mediabunny encode pipeline: `CanvasSource` + `MediaStreamAudioTrackSource` → `Output` → `StreamTarget` (`js/recorder-core.js:55-92`)
7. State machine transitions to `RECORDING`, effect calls `api.startEncoding(fps)` (`js/recorder-state-machine.js:117`)
8. `Metronome.start(fps, onFrame)` begins Worker-timed loop; each tick: `Compositor.drawFrame()` → `RecorderCore.addFrame(timestamp)` (`js/recorder-api.js:286-293`)
9. Frames are encoded via WebCodecs and muxed to disk through `FileSystemWritableFileStream`
10. On stop: `Metronome.stop()` → await `metronome.done` → `RecorderCore.finalize()` → close writable stream (`js/recorder-api.js:237-250`)

### Live Transcription Pipeline

1. Recording starts → `TranscriptionController.startLiveSession()` creates `RollingTranscriptionSession` (`js/transcription-controller.js:432`)
2. `AudioMixer` exposes a clone of the mixed audio track
3. `RollingTranscriptionSession.start()` creates a `ScriptProcessor` node on the audio graph (`js/transcription-controller.js:316-349`)
4. Every 10 seconds (`LIVE_CHUNK_MS`), accumulated PCM samples are merged, encoded as WAV, and sent to the API (`js/transcription-controller.js:390-428`)
5. API response text is merged with previous transcript using overlap detection (`js/transcription-controller.js:142-154`)
6. Merged transcript is incrementally written to disk via `MediaLibrary.writeTranscriptIncremental()` (`js/transcription-controller.js:420-427`)
7. On recording stop: final flush → save live transcript → trigger final file transcription

### File Transcription Pipeline

1. User selects media file from library → clicks "Transcribe"
2. `TranscriptionController.transcribeFile()` checks file size against `SAFE_UPLOAD_BYTES` (24 MB) (`js/transcription-controller.js:10`)
3. If under limit: direct upload to API
4. If over limit: load ffmpeg.wasm → compress to MP3 mono 24kHz 64kbps → check again (`js/transcription-controller.js:260-276`)
5. If still over: split into 10-minute chunks with 2-second overlap (`js/transcription-controller.js:15-16`)
6. Send segments sequentially, using previous transcript as context for the next
7. Merge segments using word-overlap deduplication (`js/transcription-controller.js:126-154`)
8. Save final transcript to disk with appropriate suffix based on output mode

### Authentication Flow

1. Page loads → auth gate screen displayed (`index.html:31-61`)
2. User enters password → `handleAuthSubmit()` fetches `captura-acesso.txt` (bypasses cache) (`js/app.js:~2814`)
3. Client-side PBKDF2 verification: derive key from password + salt (250k iterations, SHA-256) → compare hash
4. On success: store session token in `sessionStorage` with 30-day TTL → reveal app shell
5. On subsequent visits: check stored session before showing auth gate

## Key Abstractions

### RecorderStateMachine

- **Purpose:** Explicit FSM preventing invalid state transitions in the recording lifecycle
- **States:** `IDLE`, `REQUESTING`, `RECORDING`, `PAUSED`, `STOPPING`, `SESSION`, `ERROR`
- **Events:** `USER_START`, `USER_PAUSE`, `USER_RESUME`, `USER_STOP`, `END_SESSION`, `ENCODER_READY`, `STREAMS_FAILED`, `ENCODER_ERROR`, `FINALIZE_DONE`, `ERROR_DISMISSED`
- **Pattern:** Transition table keyed by `${state}:${event}`, with optional async `effect` functions
- **File:** `js/recorder-state-machine.js`

### RecorderAPI

- **Purpose:** Facade over all media/encoder operations; single point of contact for the state machine
- **Pattern:** Constructor injection of engine instances; all config passed via method parameters
- **File:** `js/recorder-api.js`

### TranscriptionController

- **Purpose:** Unified interface for both live and file-based transcription across multiple API providers
- **Pattern:** Strategy pattern — `getClientManager(engine)` resolves the active API client at runtime
- **File:** `js/transcription-controller.js`

### StorageManager

- **Purpose:** Abstract File System Access API complexity; guarantee writable directory before recording
- **Pattern:** Lazy initialization with `init()` → `ensureAccess()` guard before each recording
- **File:** `js/storage.js`

## Entry Points

### Main Application

- **Location:** `index.html`
- **Triggers:** Browser navigation
- **Responsibilities:** Load CSS (Bootstrap CDN, Font Awesome CDN, Google Fonts, local stylesheets), render auth gate + app shell HTML, load `scripts/formatting.js` (IIFE) and `js/app.js` (ES module)

### Module Entry Point

- **Location:** `js/app.js`
- **Triggers:** `<script type="module" src="./js/app.js">` in `index.html:596`
- **Responsibilities:** Import all modules, create engine instances, wire DOM events, bootstrap auth check, register service worker

### Service Worker

- **Location:** `sw.js`
- **Triggers:** Registered by `js/register-service-worker.js`
- **Responsibilities:** Cache-first strategy for all local assets, versioned cache (`captura-v2.4.2`), user-controlled update flow

### Auth File Generator (Build Script)

- **Location:** `scripts/generate-auth-file.js`
- **Triggers:** `node scripts/generate-auth-file.js`
- **Responsibilities:** Read `captura-acesso.source.txt`, hash passwords with PBKDF2, write `captura-acesso.txt`

## Architectural Constraints

- **Threading:** Single-threaded main loop; encoding frames awaited sequentially for back-pressure. Web Worker used only for `Metronome` timer (background-safe scheduling) and `ffmpeg.wasm` (off-main-thread media processing).
- **Global state:** No module-level singletons except `Metronome`'s inline Worker blob (shared across all instances). `app.js` holds all engine instances as module-level `const` declarations. `ffmpegPromise` in `transcription-controller.js` is a module-level lazy singleton ensuring ffmpeg loads only once.
- **Circular imports:** None detected. Dependency graph is strictly layered: `app.js` → engines → browser APIs.
- **Browser target:** Chromium only (Chrome, Edge). Requires File System Access API, `getDisplayMedia`, Service Worker, Web Audio API, WebCodecs (via Mediabunny).
- **No build step:** All JS files served as-is. ES module imports resolved by the browser. Third-party libraries loaded from CDN (`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`).
- **No backend:** All API calls go directly from browser to OpenAI/AssemblyAI. API keys entered in the UI and never persisted.

## Anti-Patterns

### God Module (app.js)

**What happens:** `js/app.js` is 2876 lines and handles DOM binding, event dispatch, state rendering, auth, media library UI, transcription UI, post-processing, meeting notes, preference management, and device enumeration — all in one file.
**Why it's wrong:** Changes to any feature area risk regressions in unrelated areas. The file is difficult to navigate and impossible to unit test in isolation.
**Do this instead:** Extract cohesive groups into modules: `js/ui/recorder-controls.js`, `js/ui/transcription-panel.js`, `js/ui/media-library-panel.js`, `js/ui/meeting-notes.js`, `js/auth.js`. Keep `app.js` as a thin bootstrap.

### Direct DOM Coupling in Engine Modules

**What happens:** `js/dialogs.js` accesses DOM elements at module load time (`document.getElementById('alert-box')`), and `js/audio-mixer.js` receives canvas elements via constructor.
**Why it's wrong:** These modules cannot be tested or reused without the full DOM present.
**Do this instead:** Accept DOM references as constructor parameters consistently, or use a render callback pattern.

### ScriptProcessorNode for Live Transcription

**What happens:** `RollingTranscriptionSession` uses `ScriptProcessorNode` (deprecated) to capture PCM audio samples (`js/transcription-controller.js:327`).
**Why it's wrong:** `ScriptProcessorNode` is deprecated in favor of `AudioWorkletNode`. It runs on the main thread and can cause audio glitches under load.
**Do this instead:** Migrate to `AudioWorkletNode` with a custom `AudioWorkletProcessor` for sample collection.

## Error Handling

**Strategy:** Layered error propagation with typed errors and UI-level presentation.

**Patterns:**
- **State machine effects** wrap async operations in try/catch and transition to `ERROR` state on failure (`js/recorder-state-machine.js:83-93`)
- **Typed error classes:** `OpenAIRequestError`, `OpenAIConfigError`, `AssemblyAIConfigError` carry status codes and model info for precise error messages (`js/openai-client.js:58-96`)
- **Custom error names:** `SysAudioNotCaptured`, `NoAudioSource` trigger specific UI illustrations in the error dialog (`js/dialogs.js:63-69`)
- **UI error presentation:** Three levels — `showAlert()` (inline banner), `showToast()` (auto-dismissing notification), `showErrorDialog()` (modal with optional illustration) (`js/dialogs.js`)
- **Transcription errors:** Centralized via `handleTranscriptionError()` in `app.js` with configurable toast/dialog/pane-update behavior

## Cross-Cutting Concerns

**Logging:** `console.warn` / `console.error` for non-critical failures. No structured logging framework.

**Validation:** Client-side only. Auth gate uses PBKDF2 hash comparison. API key validation happens on first API call (401/403 → retry with fallback model).

**Analytics:** Google Analytics via `gtag()` — all events funneled through `trackEvent()` in `js/analytics.js`. Events track preference changes, recording actions, transcription usage, and PWA updates.

**Preferences:** All user settings persisted in `localStorage` via `js/prefs.js`. Key names prefixed with `captura-`. OpenAI API key is never persisted.

**PWA:** Service Worker (`sw.js`) with cache-first strategy. Cache version (`captura-v2.4.2`) must be manually bumped on asset changes. User-controlled update via notification bar.

---

*Architecture analysis: 2026-05-31*
