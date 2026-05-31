# External Integrations

**Analysis Date:** 2026-05-31

## APIs & External Services

**AI Transcription — OpenAI:**
- Service: OpenAI Audio API
  - SDK/Client: Custom `OpenAIClientManager` class in `js/openai-client.js`
  - Auth: Bearer token from user-input password field (never persisted by the app)
  - Endpoints:
    - `POST https://api.openai.com/v1/audio/transcriptions` — Speech-to-text
    - `POST https://api.openai.com/v1/responses` — Post-processing / rewriting
  - Transcription models: `gpt-4o-transcribe` (default), `gpt-4o-mini-transcribe`, `whisper-1`, `gpt-4o-transcribe-diarize`
  - Post-processing models: `gpt-5.4-mini` (default), `gpt-5.4`
  - Timeout: 5 minutes per request (`OPENAI_REQUEST_TIMEOUT_MS`)
  - Retry logic: Automatic fallback through model list on 401/403/404 with access/permission messages
  - Features: Prompt-guided transcription, verbose JSON with segments, diarization, structured output

**AI Transcription — AssemblyAI:**
- Service: AssemblyAI REST API v2
  - SDK/Client: Custom `AssemblyAIClientManager` class in `js/openai-client.js`
  - Auth: API key from user-input password field (never persisted)
  - Endpoints:
    - `POST https://api.assemblyai.com/v2/upload` — Upload audio file
    - `POST https://api.assemblyai.com/v2/transcript` — Create transcription job
    - `GET https://api.assemblyai.com/v2/transcript/{id}` — Poll transcription status
  - Speech models: `universal-3-pro` (primary), `universal-2` (fallback on empty results)
  - Timeout: 10 minutes per transcription (`ASSEMBLYAI_REQUEST_TIMEOUT_MS`)
  - Poll interval: 3 seconds (`ASSEMBLYAI_POLL_INTERVAL_MS`)
  - Features: Language detection, speaker diarization (speaker labels), multi-model fallback

**Analytics — Google Analytics:**
- Service: Google Analytics 4 (gtag.js)
  - Implementation: Conditional — `window.gtag()` called only when available
  - Files: `js/analytics.js` (ES6 module), `scripts/formatting.js` (IIFE)
  - Events tracked: `captura_pref_change`, `image_expand`, `back_to_top`, `toc_click`, `code_copy`, `scroll_depth`, `element_viewed`, `post_share`, `tag_click`, `series_nav_click`, `related_post_click`, `manual_code_highlight`, `toc_mobile_toggle`
  - Graceful degradation: All tracking calls are wrapped in try/catch and no-op when GA is blocked

## Data Storage

**Databases:**
- None — no server-side database

**Client-Side Storage:**
- IndexedDB (`captura-db`, version 1)
  - Object store: `settings`
  - Purpose: Persist `FileSystemDirectoryHandle` across browser sessions
  - Implementation: `js/storage.js` (functions `openDB`, `idbGet`, `idbPut`)
- localStorage
  - 25+ preference keys prefixed with `captura-` (defined in `js/prefs.js`)
  - Stores: format, quality, fps, device selections, gain values, PiP position, panel states, transcription preferences
  - Auth session: `captura-auth-session` (JSON with hash + expiry, 30-day TTL)
- File System Access API
  - User-selected directory for all recording output
  - Direct streaming writes via `FileSystemWritableFileStream` (no memory buffering)

**File Storage:**
- Local filesystem only (user-selected directory via `showDirectoryPicker`)
- No cloud storage service
- Output files: recordings (MP4/WebM/MP3), transcripts (TXT), meeting notes (JSON), reformulated text (TXT)

**Caching:**
- Service Worker cache-first strategy (`sw.js`)
- Cache name: `captura-v2.4.2` (versioned; old caches purged on activate)
- Pre-cached: all local JS modules, CSS, HTML, icons, FFmpeg vendor files
- Dynamic caching: external CDN resources cached on first fetch
- Exception: `captura-acesso.txt` always fetched with `cache: 'no-store'`

## Authentication & Identity

**Access Gate (Client-Side):**
- Implementation: Custom PBKDF2 password verification in `js/app.js` (lines 571–810)
- Flow:
  1. App fetches `captura-acesso.txt` (pre-hashed passwords, one per line)
  2. User enters password in a form
  3. App derives key using `crypto.subtle.deriveBits()` with PBKDF2 (250,000 iterations, SHA-256, 32-byte output)
  4. Compares derived bits against stored hash+salt from auth file
  5. On success, stores session in `localStorage` with 30-day TTL
- Hash generation: `scripts/generate-auth-file.js` (Node.js script using `crypto.pbkdf2Sync`)
- Source file: `captura-acesso.source.txt` (gitignored) → generates `captura-acesso.txt` (committed)
- Session persistence: `localStorage` key `captura-auth-session`

**API Keys (OpenAI / AssemblyAI):**
- Not persisted by the application
- Read directly from `<input type="password">` fields at time of use
- Browser's built-in password manager may offer to remember them
- Validated via `assertConfigured()` before each API call

## Monitoring & Observability

**Error Tracking:**
- None — no external error tracking service (Sentry, LogRocket, etc.)
- Errors displayed to user via toast notifications (`showToast`) or modal dialogs (`showErrorDialog`)
- Implementation: `js/dialogs.js`

**Logs:**
- Browser `console.warn` for Service Worker registration failures (`js/register-service-worker.js:38`)
- No structured logging framework
- No server-side logs (no backend)

## CI/CD & Deployment

**Hosting:**
- Static hosting (GitHub Pages or equivalent)
- No server infrastructure

**CI Pipeline:**
- None detected — no `.github/workflows/`, no CI configuration files

**Deployment:**
- Manual: push to repository, static files served directly
- Service Worker cache version (`CACHE_NAME` in `sw.js`) must be bumped manually for updates to propagate

## CDN Resources

**jsdelivr.net:**
- `mediabunny@1.40.1` — Video/audio encoding
- `@mediabunny/mp3-encoder@1.40.1` — MP3 encoder plugin
- `@ffmpeg/ffmpeg@0.12.10` — FFmpeg WASM wrapper
- `@ffmpeg/util@0.12.1` — FFmpeg file utilities
- `@ffmpeg/core@0.12.6` — FFmpeg WASM core (also via unpkg)
- `bootstrap@5.3.3` — CSS framework

**cdnjs.cloudflare.com:**
- `font-awesome/6.5.2` — Icon library (with SRI hash)

**fonts.googleapis.com / fonts.gstatic.com:**
- Inter font family (weights 400, 500, 600, 700, 800)

**unpkg.com:**
- `@ffmpeg/core@0.12.6` — FFmpeg WASM core (referenced in `js/vendor/ffmpeg/const.js`)

## Environment Configuration

**Required env vars (for test scripts only):**
- `OPENAI_API_KEY` — Used by `scripts/test-openai-transcriptions.sh`
- `ASSEMBLYAI_API_KEY` — Used by `scripts/test-assemblyai-transcription.sh`
- `OPENAI_TRANSCRIPTION_MODEL` — Optional override (default: `gpt-4o-transcribe`)
- `OPENAI_TRANSCRIPTION_PROMPT` — Optional prompt for test transcriptions
- `TEST_DIR` — Optional override for test audio directory (default: `arquivos-teste/`)

**Secrets location:**
- API keys: entered by user at runtime in browser UI (not stored)
- Access gate passwords: `captura-acesso.source.txt` (gitignored) → `captura-acesso.txt` (hashed, committed)
- `.env` file: gitignored, not consumed by application code

## Webhooks & Callbacks

**Incoming:**
- None — no server to receive webhooks

**Outgoing:**
- None — no webhook dispatch from the application

## Offline Support

**Service Worker (`sw.js`):**
- Cache-first strategy for all GET requests
- Pre-caches all local assets on install
- Dynamically caches CDN responses on first fetch
- User-controlled update flow: new version shows a banner with "Update Now" button
- `SKIP_WAITING` message triggers immediate activation of waiting worker
- PWA installable via `manifest.json` (standalone display mode)

## Media Session Integration

**OS Media Controls:**
- Implementation: `js/media-session.js`
- Metadata: title "Gravador de Reuniões", artist "Recording Session Active", artwork from `images/captura.png`
- Action handlers: play, pause, stop
- Purpose: Enable hardware media keys and lock-screen controls during recording

---

*Integration audit: 2026-05-31*
