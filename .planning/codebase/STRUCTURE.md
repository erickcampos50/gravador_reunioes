# Codebase Structure

**Analysis Date:** 2026-05-31

## Directory Layout

```
gravador-reunioes/
├── index.html                  # Single-page application HTML (598 lines)
├── recorder.css                # Legacy/app-specific CSS (42,915 bytes)
├── recorder.js                 # Deprecated stub — points to js/app.js
├── sw.js                       # Service Worker (cache-first PWA)
├── manifest.json               # PWA web app manifest
├── captura-acesso.txt          # Published auth file (hash-only, generated)
├── captura-acesso.source.txt   # Local-only auth source (gitignored)
├── MEMORIAL-TECNICO.md         # Technical design document (Portuguese)
├── README.md                   # Project documentation
├── .gitignore                  # Ignores .env and captura-acesso.source.txt
│
├── js/                         # Application JavaScript (ES6 modules)
│   ├── app.js                  # Main orchestrator / UI layer (2876 lines)
│   ├── recorder-state-machine.js  # Recording FSM (180 lines)
│   ├── recorder-api.js         # Media acquisition + encoder lifecycle (339 lines)
│   ├── recorder-core.js        # Mediabunny encoder wrapper (128 lines)
│   ├── audio-mixer.js          # Web Audio mixing + level meters (283 lines)
│   ├── compositor.js           # Canvas compositing + PiP overlay (214 lines)
│   ├── metronome.js            # Web Worker frame timer (83 lines)
│   ├── storage.js              # File System Access + IndexedDB (176 lines)
│   ├── media-library.js        # Media file listing + transcript I/O (359 lines)
│   ├── openai-client.js        # OpenAI + AssemblyAI API clients (770 lines)
│   ├── transcription-controller.js  # Live + file transcription (698 lines)
│   ├── prefs.js                # localStorage preference helpers (28 lines)
│   ├── dialogs.js              # Alert/toast/dialog UI helpers (80 lines)
│   ├── media-session.js        # Media Session API integration (22 lines)
│   ├── analytics.js            # Google Analytics wrapper (12 lines)
│   ├── register-service-worker.js  # PWA SW registration (47 lines)
│   └── vendor/
│       └── ffmpeg/             # Local ffmpeg.wasm worker shim
│           ├── worker.js       # Web Worker message handler (144 lines)
│           ├── const.js        # Core URL + message type constants (22 lines)
│           └── errors.js       # Error code constants (4 lines)
│
├── styles/
│   └── styles.css              # Global design system CSS
│
├── scripts/
│   ├── generate-auth-file.js   # Node.js auth hash generator (96 lines)
│   └── formatting.js           # Blog-style IIFE (TOC, lightbox, scroll-spy) (288 lines)
│
├── icons/                      # PWA icons
│   ├── icon-192.png
│   └── icon-512.png
│
├── images/                     # Static images
│   ├── favicon.ico
│   └── captura.png
│
├── arquivos-teste/             # Test files directory
│
├── .planning/                  # GSD planning artifacts
│   └── codebase/               # Codebase analysis documents
│
└── .qwen/                      # Qwen IDE settings
    └── settings.json
```

## Directory Purposes

### `js/` — Application Source Code

- **Purpose:** All application logic as ES6 modules
- **Contains:** 16 module files + 1 vendor subdirectory
- **Key files:**
  - `js/app.js` — Main entry point and UI orchestrator (2876 lines, largest file)
  - `js/recorder-state-machine.js` — Recording lifecycle FSM
  - `js/recorder-api.js` — Media stream acquisition and encoder pipeline
  - `js/openai-client.js` — OpenAI and AssemblyAI API client managers
  - `js/transcription-controller.js` — Live and file-based transcription orchestration

### `js/vendor/ffmpeg/` — Local ffmpeg.wasm Worker

- **Purpose:** Custom Web Worker shim for `@ffmpeg/ffmpeg` that loads the core from CDN
- **Contains:** Worker message handler, URL constants, error codes
- **Key files:**
  - `js/vendor/ffmpeg/worker.js` — Handles LOAD, EXEC, WRITE_FILE, READ_FILE messages
  - `js/vendor/ffmpeg/const.js` — `CORE_URL` pointing to `@ffmpeg/core@0.12.6` on jsDelivr
- **Generated:** No (hand-maintained fork/adaptation)
- **Committed:** Yes

### `styles/` — Global Stylesheets

- **Purpose:** Design system and global styles
- **Contains:** Single `styles.css` file
- **Key files:** `styles/styles.css`

### `scripts/` — Build and Utility Scripts

- **Purpose:** Node.js build tools and client-side utility scripts
- **Contains:** Auth file generator (Node.js) and formatting IIFE (browser)
- **Key files:**
  - `scripts/generate-auth-file.js` — Run with `node scripts/generate-auth-file.js` to hash passwords
  - `scripts/formatting.js` — Loaded as `<script>` (non-module) for blog-style enhancements (TOC, lightbox, scroll tracking)

### `icons/` — PWA Icons

- **Purpose:** Web app manifest icons for install prompt and home screen
- **Contains:** PNG icons at 192×192 and 512×512

### `images/` — Static Images

- **Purpose:** Favicon, branding images, instructional GIFs
- **Contains:** `favicon.ico`, `captura.png`, system audio instruction GIF

### `arquivos-teste/` — Test Files

- **Purpose:** Sample media files for manual testing
- **Contains:** Test audio/video files

## Key File Locations

### Entry Points

- `index.html`: Single-page application shell — auth gate, recorder UI, transcription panel, media library
- `js/app.js`: ES module entry point — imports all modules, creates instances, wires events
- `sw.js`: Service Worker entry — cache-first strategy, versioned cache name

### Configuration

- `manifest.json`: PWA manifest (name, icons, display mode, theme color)
- `js/prefs.js`: All `localStorage` key names (prefixed `captura-`)
- `.gitignore`: Excludes `.env` and `captura-acesso.source.txt`
- `captura-acesso.txt`: Published auth hashes (generated, committed)

### Core Logic

- `js/recorder-state-machine.js`: Recording FSM — states, events, transition table
- `js/recorder-api.js`: Media pipeline — `getDisplayMedia`, `getUserMedia`, encoder init
- `js/recorder-core.js`: Mediabunny integration — WebCodecs encoding to `FileSystemWritableFileStream`
- `js/audio-mixer.js`: Audio graph — system + mic mixing, gain control, level meters
- `js/compositor.js`: Canvas rendering — screen capture + webcam PiP + timestamp overlay
- `js/metronome.js`: Frame timing — Worker-based timer for background-safe recording
- `js/storage.js`: File I/O — directory picker, permission management, IndexedDB persistence
- `js/media-library.js`: File management — media enumeration, transcript naming, notes I/O
- `js/openai-client.js`: API integration — OpenAI transcription + responses, AssemblyAI upload + poll
- `js/transcription-controller.js`: Transcription orchestration — live chunking, file compression/splitting

### Testing

- `arquivos-teste/`: Manual test media files
- No automated test framework detected

### Styles

- `recorder.css`: Application-specific styles (42,915 bytes)
- `styles/styles.css`: Global design system
- External: Bootstrap 5.3.3 (CDN), Font Awesome 6.5.2 (CDN), Inter font (Google Fonts)

## Naming Conventions

### Files

- **Modules:** kebab-case with descriptive names — `recorder-state-machine.js`, `audio-mixer.js`, `transcription-controller.js`
- **Vendor:** Nested under `vendor/<library>/` — `vendor/ffmpeg/worker.js`
- **Styles:** kebab-case — `recorder.css`, `styles.css`
- **Scripts:** kebab-case — `generate-auth-file.js`, `formatting.js`
- **Generated outputs:** descriptive with timestamp — `recording-2026-04-30T13-51-28.mp3`

### Directories

- **Flat structure:** Most directories are single-level (no deep nesting)
- **Vendor isolation:** Third-party code isolated in `js/vendor/<name>/`
- **Separation by concern:** `js/` (app code), `scripts/` (build tools), `styles/` (CSS), `icons/` (PWA), `images/` (static assets)

### Code Conventions

- **Classes:** PascalCase — `RecorderStateMachine`, `AudioMixer`, `StorageManager`
- **Functions:** camelCase — `buildMix()`, `acquireAndInit()`, `drawFrame()`
- **Private fields:** `#` prefix — `#state`, `#audioCtx`, `#dirHandle`
- **Constants:** UPPER_SNAKE_CASE at module level — `SAFE_UPLOAD_BYTES`, `LIVE_CHUNK_MS`, `CACHE_NAME`
- **Enums:** Frozen objects — `STATE = Object.freeze({...})`, `EVENT = Object.freeze({...})`
- **DOM references:** Descriptive camelCase with `El`/`Btn`/`Sel`/`Chk` suffix — `startBtn`, `formatSel`, `sysAudioChk`, `transcriptViewerEl`
- **Preference keys:** `captura-` prefix + camelCase — `captura-fps`, `captura-liveTranscriptionEnabled`

## Where to Add New Code

### New Recording Feature

- **State machine changes:** `js/recorder-state-machine.js` — add states/events to the enums and transition table
- **Media pipeline changes:** `js/recorder-api.js` — add acquisition or encoding logic
- **UI controls:** `js/app.js` — add DOM references, event listeners, and render logic (consider extracting to a new module if `app.js` grows further)

### New Transcription Provider

- **API client:** Add a new class in `js/openai-client.js` following the `OpenAIClientManager` / `AssemblyAIClientManager` pattern (implement `transcribeFile()`, `assertConfigured()`)
- **Engine registration:** Add to `TRANSCRIPTION_ENGINES` enum and wire into `transcriptionClients` map in `js/app.js:190-193`
- **UI panel:** Add provider-specific key input panel in `index.html` and corresponding DOM refs in `js/app.js`

### New UI Panel or Section

- **HTML:** Add to `index.html` within the `<main class="captura-shell">` section
- **CSS:** Add to `recorder.css` (app-specific) or `styles/styles.css` (design system)
- **JS:** Add DOM references and event handlers in `js/app.js` — consider extracting to `js/ui/<panel-name>.js` for large features

### New Utility or Helper

- **Shared helpers:** Create `js/<name>.js` as an ES module with named exports
- **Import in app.js:** Add to the import block at the top of `js/app.js`

### New Build/Dev Script

- **Location:** `scripts/<name>.js`
- **Convention:** Node.js scripts with `#!/usr/bin/env node` shebang

## Special Directories

### `.planning/`

- **Purpose:** GSD workflow artifacts — phase plans, codebase maps, roadmaps
- **Generated:** Yes (by GSD commands)
- **Committed:** Yes

### `js/vendor/ffmpeg/`

- **Purpose:** Local adaptation of `@ffmpeg/ffmpeg` worker for custom core URL loading
- **Generated:** No (hand-maintained)
- **Committed:** Yes
- **Note:** The actual ffmpeg WASM core is loaded from CDN at runtime (`@ffmpeg/core@0.12.6`)

### `arquivos-teste/`

- **Purpose:** Sample media files for manual testing during development
- **Generated:** No
- **Committed:** Yes

### `.qwen/`

- **Purpose:** Qwen IDE configuration
- **Generated:** Yes (by IDE)
- **Committed:** Yes

## File Naming for Generated Outputs

Recording and transcript files follow strict naming conventions defined in `js/media-library.js` and `js/storage.js`:

| Pattern | Description |
|---------|-------------|
| `recording-<dateStamp>.<ext>` | Raw recording file (webm, mp4, or mp3) |
| `<base>-transcript.txt` | Final transcript (plain text) |
| `<base>-transcript-segmentos.txt` | Final transcript with timestamps |
| `<base>-transcript-diarizado.txt` | Final transcript with speaker labels |
| `<base>-transcript-live.txt` | Live transcript accumulated during recording |
| `<base>-transcript-reformulado.txt` | Post-processed transcript |
| `<base>-notes.json` | Structured meeting notes |
| `<base>-metadata.json` | Event description metadata |
| `<base>-transcript-<dateStamp>.txt` | Versioned transcript snapshot |

The `dateStamp()` function in `js/storage.js:41-55` produces `YYYY-MM-DDTHH-MM-SS` format in `America/Sao_Paulo` timezone.

---

*Structure analysis: 2026-05-31*
