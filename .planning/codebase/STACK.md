# Technology Stack

**Analysis Date:** 2026-05-31

## Languages

**Primary:**
- JavaScript (ES2022+) - All application logic, ES6 modules with `import`/`export`, private class fields (`#field`), async/await, optional chaining
- HTML5 - Single-page application in `index.html` (598 lines)
- CSS3 - Styling in `recorder.css` and `styles/styles.css`

**Secondary:**
- Node.js (v18+) - Only for `scripts/generate-auth-file.js` (PBKDF2 password hash generator)
- Bash - Test scripts in `scripts/test-openai-transcriptions.sh` and `scripts/test-assemblyai-transcription.sh`
- Python 3 - Inline helper within bash test scripts for JSON parsing

## Runtime

**Environment:**
- Browser-only (Chromium target: Chrome, Edge)
- Required browser APIs: File System Access API, `getDisplayMedia`, Web Audio API, WebCodecs, Media Session API, IndexedDB, Service Worker, Web Crypto API
- Not targeted: Firefox, Safari, mobile browsers

**Package Manager:**
- None — no `package.json`, no `node_modules`, no build step
- Lockfile: Not applicable

**Build System:**
- None — static files served directly (GitHub Pages compatible)
- No bundler, no transpiler, no minifier

## Frameworks

**Core:**
- Bootstrap 5.3.3 - CSS framework loaded from CDN (`index.html:12`)
- Font Awesome 6.5.2 - Icon library loaded from CDN (`index.html:11`)

**Testing:**
- No test framework — testing is manual via bash scripts in `scripts/`

**Build/Dev:**
- No build tools — files are served as-is
- Service Worker (`sw.js`) provides cache-first PWA strategy

## Key Dependencies

**Critical (loaded via CDN at runtime):**
- Mediabunny 1.40.1 - Video/audio encoding pipeline (WebCodecs + mux to MP4/WebM/MP3)
  - URL: `https://cdn.jsdelivr.net/npm/mediabunny@1.40.1/+esm`
  - Used in: `js/recorder-core.js`
- @mediabunny/mp3-encoder 1.40.1 - MP3 encoding support
  - URL: `https://cdn.jsdelivr.net/npm/@mediabunny/mp3-encoder@1.40.1/+esm`
  - Used in: `js/recorder-core.js`
- @ffmpeg/ffmpeg 0.12.10 - In-browser audio processing (compression, chunking, format conversion)
  - URL: `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js`
  - Used in: `js/transcription-controller.js`
- @ffmpeg/util 0.12.1 - File utilities for FFmpeg
  - URL: `https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js`
  - Used in: `js/transcription-controller.js`
- @ffmpeg/core 0.12.6 - FFmpeg WASM core (loaded by worker)
  - URL: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm`
  - Also referenced in: `js/vendor/ffmpeg/const.js` (via unpkg)

**UI:**
- Bootstrap 5.3.3 - Layout, components, responsive grid
  - URL: `https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css`
- Font Awesome 6.5.2 - Icons
  - URL: `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css`
- Google Fonts (Inter 400/500/600/700/800) - Typography
  - URL: `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap`

**Local vendor files:**
- `js/vendor/ffmpeg/const.js` - FFmpeg message type constants and core URL
- `js/vendor/ffmpeg/errors.js` - FFmpeg error definitions
- `js/vendor/ffmpeg/worker.js` - FFmpeg Web Worker proxy (loads core via importScripts/dynamic import)

## Configuration

**Environment:**
- No `.env` file consumed at runtime (`.env` is in `.gitignore` but not referenced by app code)
- API keys (OpenAI, AssemblyAI) entered by the user in password fields at runtime — never persisted by the app
- `.env` file present - contains environment configuration (excluded from analysis)

**Build:**
- No build configuration files (no `tsconfig.json`, no bundler configs)
- Service Worker cache version is hardcoded in `sw.js:5`: `const CACHE_NAME = 'captura-v2.4.2'`

**PWA:**
- `manifest.json` - PWA manifest with app name, icons, display mode (`standalone`), theme color (`#F5F5F7`)
- Icons: `icons/icon-192.png`, `icons/icon-512.png` (including maskable variant)

## Platform Requirements

**Development:**
- Any static file server (e.g., `python3 -m http.server`, `npx serve`, VS Code Live Server)
- Must serve over `https://` or `localhost` for Service Worker and File System Access API
- Chromium-based browser (Chrome or Edge, current version)

**Production:**
- Static hosting (GitHub Pages or equivalent)
- HTTPS required
- No server-side runtime

**Node.js (scripts only):**
- Node.js for `scripts/generate-auth-file.js` (uses `crypto.pbkdf2Sync` for PBKDF2 hashing)
- Python 3 for inline JSON parsing in bash test scripts

## Browser APIs Used

**Media Capture:**
- `navigator.mediaDevices.getDisplayMedia()` - Screen capture
- `navigator.mediaDevices.getUserMedia()` - Webcam and microphone

**Audio:**
- `AudioContext` / `webkitAudioContext` - Audio graph mixing, live transcription capture
- `GainNode`, `AnalyserNode`, `ScriptProcessorNode` - Mixing, level metering, PCM capture
- `MediaStreamDestination` - Mixed audio output

**Storage:**
- File System Access API (`showDirectoryPicker`, `FileSystemWritableFileStream`) - Direct disk writing
- IndexedDB - Persist directory handle across sessions
- `localStorage` - User preferences (25+ keys defined in `js/prefs.js`)

**Encoding:**
- WebCodecs (via Mediabunny) - Hardware-accelerated H.264/VP9/AAC encoding
- `CanvasSource` - Canvas-to-video frame pipeline

**PWA:**
- Service Worker API - Offline cache, update flow
- Media Session API - OS media controls and lock-screen metadata
- Web App Manifest - Installable PWA

**Security:**
- Web Crypto API (`crypto.subtle`) - PBKDF2 key derivation for access gate, SHA-256 digest

---

*Stack analysis: 2026-05-31*
