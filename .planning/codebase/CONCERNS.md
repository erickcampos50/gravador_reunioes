# Codebase Concerns

**Analysis Date:** 2026-05-31

## Tech Debt

**`app.js` God Module (2876 lines):**
- Issue: A single file handles UI rendering, authentication, transcription orchestration, meeting notes CRUD, media library management, device enumeration, preference management, clipboard operations, and bootstrap logic. It holds 40+ module-level mutable variables (lines 307–341) and 80+ DOM references (lines 90–170).
- Files: `js/app.js`
- Impact: Any change risks unintended side effects across unrelated features. Code review is difficult because the blast radius of any edit is unclear. New features tend to increase the file rather than create new modules. Parallel work on different features causes merge conflicts.
- Fix approach: Extract into focused modules: `auth-gate.js` (authentication, lines 517–843), `meeting-notes.js` (notes CRUD + persistence, lines 922–1491), `media-browser.js` (library rendering + selection, lines 896–1856), `transcription-ui.js` (transcription/post-process UI orchestration, lines 1858–2168), `device-manager.js` (enumeration + prefs, lines 2476–2588), `render.js` (state-driven UI updates, lines 2172–2260). Keep `app.js` as a thin wiring layer that imports modules and attaches event listeners.

**`recorder.css` Monolith (2039 lines):**
- Issue: All styles in a single CSS file with no component-level organization.
- Files: `recorder.css`
- Impact: Difficult to locate styles for a specific component. Risk of selector collisions and dead CSS.
- Fix approach: Split into component-scoped CSS files (e.g., `auth-gate.css`, `library.css`, `meeting-notes.css`, `recorder-controls.css`) imported from a root stylesheet or via `<link>` tags.

**Dead `recorder.js` File:**
- Issue: `recorder.js` contains only a 4-line comment stating it has been superseded by the ES6 module architecture, but remains committed.
- Files: `recorder.js`
- Impact: Confuses new contributors about the entry point.
- Fix approach: Delete the file and remove it from git.

**Duplicate Response-Text Extraction:**
- Issue: `extractPostProcessResponseText()` in `js/app.js` (lines 211–229) is functionally identical to `extractResponseText()` in `js/openai-client.js` (lines 139–157). Both parse the OpenAI Responses API output structure.
- Files: `js/app.js`, `js/openai-client.js`
- Impact: Bug fixes or API changes must be applied in two places. Risk of divergence.
- Fix approach: Export `extractResponseText` from `js/openai-client.js` and import it in `js/app.js`. Remove the duplicate and the `fallbackPostProcessText` function (lines 231–295) since `openAiClient.postProcessText` already exists.

**Service Worker Cache Version Hardcoded:**
- Issue: `CACHE_NAME = 'captura-v2.4.2'` in `sw.js` (line 5) must be manually bumped on every deploy. The `ASSETS_TO_CACHE` array (lines 9–39) must also be kept in sync with actual files.
- Files: `sw.js`
- Impact: Forgetting to bump the version means users get stale assets. Adding a new JS module without updating the array means it won't be available offline.
- Fix approach: Introduce a minimal build step that generates `sw.js` from a template, injecting a content-hash-based cache name and the actual file list. Alternatively, use a cache-busting query parameter on the service worker registration.

**Hardcoded AI Model Names:**
- Issue: Model identifiers `gpt-5.4-mini` and `gpt-5.4` are hardcoded in `js/openai-client.js` (lines 28–30). These will become stale as OpenAI releases new models.
- Files: `js/openai-client.js`
- Impact: Users cannot select newer models without a code change. Deprecated models will cause runtime errors.
- Fix approach: Fetch available models from the OpenAI API at runtime, or move model lists to a configuration file that can be updated without touching business logic.

## Known Bugs

**Stale `fallbackPostProcessText` Reference:**
- Symptoms: The `postProcessText` binding at line 293 of `js/app.js` checks `typeof openAiClient.postProcessText === 'function'` and falls back to `fallbackPostProcessText` if it doesn't exist. This fallback duplicates logic and uses a different `DEFAULT_POSTPROCESS_PROMPT` constant (defined in `js/app.js` line 57) than the one in `js/openai-client.js` (line 33).
- Files: `js/app.js` (lines 231–295), `js/openai-client.js` (line 33)
- Trigger: If `openAiClient.postProcessText` is ever removed or renamed, the fallback silently activates with a different prompt default.
- Workaround: Currently the primary path is always taken since `postProcessText` exists on the client.

**`beforeunload` Blob URL Leak:**
- Symptoms: `showSaveSuccessToast()` (line 2385) creates a blob URL and registers a `beforeunload` listener with `{ once: true }` for each recording saved. If multiple recordings are saved in one session, multiple `beforeunload` listeners accumulate.
- Files: `js/app.js` (lines 2390–2398)
- Trigger: Save multiple recordings in one session without closing the tab.
- Workaround: The 5-minute `BLOB_URL_REVOKE_TIMEOUT_MS` (line 40) mitigates this for most cases.

## Security Considerations

**Client-Side Authentication Bypass:**
- Risk: The auth gate (`js/app.js` lines 517–843) is purely client-side. The password hashes in `captura-acesso.txt` are served to the browser. Any user can bypass authentication by opening DevTools and calling `showMainApp()` or setting `authUnlocked = true` in the console.
- Files: `js/app.js`, `captura-acesso.txt`
- Current mitigation: PBKDF2 with 250,000 iterations and constant-time comparison (lines 575–607) protect against offline brute-force. The auth file is fetched with `cache: 'no-store'` (line 710).
- Recommendations: This is acceptable only if the auth gate is a convenience feature (not protecting sensitive data). If real security is needed, add a backend proxy or server-side authentication. Document the security model explicitly.

**API Keys in localStorage:**
- Risk: OpenAI and AssemblyAI API keys are stored in `<input>` elements and persisted via `js/prefs.js` to `localStorage`. Any XSS vulnerability or browser extension with storage access can read them.
- Files: `js/prefs.js`, `js/openai-client.js`, `index.html` (lines 121–126)
- Current mitigation: No known XSS vectors. API key inputs use `type="password"` by default.
- Recommendations: Add a Content Security Policy (CSP) meta tag to prevent inline script execution. Consider warning users that API keys are stored in plaintext in the browser.

**No Content Security Policy:**
- Risk: No CSP meta tag or headers are set. The app loads external resources from CDNs (Bootstrap, Font Awesome, Google Fonts, jsdelivr for FFmpeg/Mediabunny). Without CSP, an XSS vulnerability could load arbitrary scripts.
- Files: `index.html`
- Current mitigation: SRI hashes on Bootstrap and Font Awesome CDN links (lines 11–12).
- Recommendations: Add a `<meta http-equiv="Content-Security-Policy">` tag restricting `script-src` to `self` and the specific CDN origins. Restrict `connect-src` to the OpenAI and AssemblyAI API endpoints.

**`innerHTML` Assignments:**
- Risk: 8 instances of `innerHTML` assignment in `js/app.js` (lines 1135, 1255, 1514, 1621, 2189, 2201, 2482, 2485). While most use static HTML or icon class names, the pattern creates XSS risk if any future change introduces user-controlled content.
- Files: `js/app.js`
- Current mitigation: All current innerHTML values use hardcoded strings or controlled enum values (e.g., `'video'`, `'audio'`).
- Recommendations: Replace `innerHTML` with `createElement`/`textContent` or use `DOMParser`. At minimum, add a linting rule to flag new `innerHTML` assignments.

## Performance Bottlenecks

**Full DOM Rebuild on State Change:**
- Problem: `renderMediaFileList()` (line 1632) calls `mediaFileListEl.replaceChildren()` and rebuilds every list item from scratch on every state change, preference change, and transcription status update.
- Files: `js/app.js` (lines 1632–1662)
- Cause: No virtual DOM or diffing. The `render()` function (line 2172) is called from the state machine listener, event handlers, and multiple async callbacks.
- Improvement path: Implement a lightweight diffing approach — only rebuild list items that changed. Alternatively, use `DocumentFragment` and update only the `is-disabled`/`active` classes on existing DOM nodes rather than rebuilding.

**FFmpeg WASM Loaded from CDN on Every Cold Start:**
- Problem: FFmpeg core (~30MB WASM binary) is fetched from `cdn.jsdelivr.net` on first transcription. The service worker caches it, but the initial load is slow on poor connections.
- Files: `js/transcription-controller.js` (lines 1, 17, 260–276)
- Cause: `@ffmpeg/core` WASM is too large to bundle locally without a build step.
- Improvement path: Add a loading progress indicator. Consider self-hosting the WASM files for production deployments to avoid CDN latency and availability risks.

**No Build Step / No Minification:**
- Problem: All JavaScript is served as raw ES modules without minification, tree-shaking, or bundling. `js/app.js` alone is 106KB uncompressed.
- Files: All `js/*.js` files
- Cause: Project has no build tooling (no bundler, no `package.json`).
- Improvement path: Introduce a lightweight bundler (e.g., esbuild) to produce minified bundles. This would reduce total JS payload by ~60-70% and enable dead-code elimination.

## Fragile Areas

**Meeting Notes Save Pipeline:**
- Files: `js/app.js` (lines 1376–1477)
- Why fragile: The save pipeline uses 8 module-level state variables (`meetingNotesDirty`, `meetingNotesSaving`, `meetingNotesQueuedSave`, `meetingNotesSaveTimerId`, `meetingNotesSavePromise`, `meetingNotesSessionFileName`, `meetingNotesSessionActive`, `meetingNotesUiLocked`) with timer-based debouncing (300ms), recursive save queuing, and manual promise chaining. Race conditions between `queueMeetingNotesSave`, `flushMeetingNotesSave`, and `saveMeetingNotesToDisk` are difficult to reason about.
- Safe modification: Always test: (1) rapid note creation, (2) editing while save is in flight, (3) stopping recording while notes are dirty, (4) browser close during save. Never change the `finally` block in `saveMeetingNotesToDisk` without understanding the queued-save recursion at line 1470.
- Test coverage: None.

**Transcription Controller Audio Pipeline:**
- Files: `js/transcription-controller.js` (lines 278–430)
- Why fragile: Uses the deprecated `ScriptProcessorNode` API (`createScriptProcessor`, line 327) which runs on the main thread and can cause audio glitches. The rolling transcription session merges chunks using word-overlap deduplication (lines 126–154) which can produce incorrect merges when speakers repeat similar phrases.
- Safe modification: When changing chunk processing, test with: (1) very short utterances (< 0.35s), (2) long silences between speech, (3) overlapping speakers, (4) pause/resume during live transcription. The `#processing` promise chain (line 294) must never reject without being caught.
- Test coverage: None.

**State Machine Effect Error Handling:**
- Files: `js/recorder-state-machine.js` (lines 73–77)
- Why fragile: Effect errors are caught by a single `.catch()` that logs to `console.error` but does not transition to `STATE.ERROR`. If an effect throws before calling `machine.transition()`, the state machine stays in the pre-transition state (e.g., `REQUESTING`) indefinitely, leaving the UI in a frozen "Preparing…" state.
- Safe modification: Every effect function must either call `machine.transition()` on all code paths or the outer catch must transition to `STATE.ERROR`. Currently `effectAcquireAndInit` and `effectFinalize` handle this correctly, but inline effects (lines 117, 129, 162, 166) do not.
- Test coverage: None.

**File System Access API Permission Lifecycle:**
- Files: `js/storage.js` (lines 100–134)
- Why fragile: The `ensureAccess()` method must handle: no directory handle, handle with revoked permission, permission request denied, and permission request dismissed. The `silent` and `requestIfNeeded` parameters create 4 behavior modes. Callers pass different combinations (e.g., `{ silent: true, requestIfNeeded: false }` in meeting notes save vs `{ silent: false, requestIfNeeded: true }` in transcription), making the permission flow hard to trace.
- Safe modification: When changing `ensureAccess`, test: (1) first visit (no handle), (2) returning visit with persisted handle, (3) handle with revoked permission, (4) user denies permission request, (5) private browsing (no IndexedDB).
- Test coverage: None.

## Scaling Limits

**Recording File Size:**
- Current capacity: Recording writes directly to disk via `FileSystemWritableFileStream`, so file size is limited only by disk space.
- Limit: At 1080p/30fps with system audio, recordings consume ~1GB per hour (per `VIDEO_BITRATES` at line 43 of `js/app.js`). Long meetings can exceed available disk space without warning.
- Scaling path: Add a disk space check before recording starts using `navigator.storage.estimate()`. Show a warning when estimated recording size exceeds available space.

**Media Library Listing:**
- Current capacity: `listDirectoryFileHandles()` in `js/storage.js` (line 136) reads all file handles into memory and sorts them.
- Limit: Directories with thousands of files will cause UI lag during `refreshMediaLibrary()` (line 1820 of `js/app.js`) because every file handle is read, metadata extracted, and DOM elements created.
- Scaling path: Implement virtual scrolling for the media list. Paginate or lazy-load file entries. Cache the library listing and invalidate on directory change.

## Dependencies at Risk

**Mediabunny (CDN-only, no fallback):**
- Risk: `mediabunny@1.40.1` and `@mediabunny/mp3-encoder@1.40.1` are loaded exclusively from `cdn.jsdelivr.net` via dynamic `import()` in `js/recorder-core.js` (lines 10–11). If jsdelivr is down or the package is unpublished, recording is completely broken.
- Impact: Core recording functionality fails with no offline fallback.
- Migration plan: Self-host the Mediabunny ESM bundles. Add a local fallback path in `js/vendor/`. The service worker already caches CDN responses, but only after the first successful fetch.

**FFmpeg WASM (CDN-only, deprecated API):**
- Risk: `@ffmpeg/ffmpeg@0.12.10` and `@ffmpeg/core@0.12.6` loaded from jsdelivr in `js/transcription-controller.js` (lines 1–2, 17). The `ScriptProcessorNode` API used alongside it (line 327) is deprecated and may be removed from future browser versions.
- Impact: Transcription features fail if CDN is unavailable. Audio processing may break in future browser updates.
- Migration plan: Replace `ScriptProcessorNode` with `AudioWorkletNode`. Self-host FFmpeg WASM files. Pin versions and add integrity checks.

**Bootstrap 5.3.3 and Font Awesome 6.5.2 (CDN with SRI):**
- Risk: Loaded from CDN in `index.html` (lines 11–12). SRI hashes protect against tampering but not against CDN unavailability.
- Impact: UI layout breaks without Bootstrap. Icons disappear without Font Awesome.
- Migration plan: Self-host CSS and font files. The service worker caches them after first load, but cold-start availability depends on CDN uptime.

## Missing Critical Features

**No Automated Tests:**
- Problem: Zero test files exist in the project. No test runner, no test configuration, no test scripts.
- Blocks: Confident refactoring of `app.js`, regression detection when adding features, CI/CD quality gates.

**No Build System:**
- Problem: No `package.json`, no bundler, no transpiler, no linter configuration. The project is a collection of raw ES modules served directly to the browser.
- Blocks: Minification, tree-shaking, dead-code elimination, dependency management, automated testing, linting, type checking.

**No Error Reporting:**
- Problem: Errors are shown to the user via dialogs/toasts and logged to `console.error`/`console.warn`. No error tracking service (Sentry, Bugsnag, etc.) is integrated.
- Blocks: Understanding production failure rates, prioritizing bug fixes, detecting regressions after deployment.

## Test Coverage Gaps

**Entire Codebase — Zero Tests:**
- What's not tested: All 14 JavaScript modules (~9,450 lines of code) have no automated tests of any kind.
- Files: All files in `js/`, `scripts/`
- Risk: Any code change can introduce regressions undetected. The complex state machine (`js/recorder-state-machine.js`), audio mixing (`js/audio-mixer.js`), and transcription chunk merging (`js/transcription-controller.js`) are particularly risky without tests.
- Priority: High

**Authentication Logic:**
- What's not tested: PBKDF2 derivation, constant-time comparison, session persistence, auth file parsing, fingerprint validation.
- Files: `js/app.js` (lines 517–843), `scripts/generate-auth-file.js`
- Risk: Auth bypass or lockout from subtle parsing bugs.
- Priority: High

**State Machine Transitions:**
- What's not tested: All 18 state transitions in `js/recorder-state-machine.js` (lines 109–179), including edge cases like `END_SESSION` during `RECORDING` and `ENCODER_ERROR` from wildcard states.
- Files: `js/recorder-state-machine.js`
- Risk: Invalid state transitions could leave the UI frozen or recording resources leaked.
- Priority: High

**Transcription Chunk Merging:**
- What's not tested: Word-overlap deduplication (`findWordOverlap`, line 126), segment merging (`mergeStructuredSegments`, line 214), and the rolling transcript assembly in `RollingTranscriptionSession`.
- Files: `js/transcription-controller.js` (lines 101–232)
- Risk: Duplicate text, lost segments, or incorrect speaker labels in transcriptions.
- Priority: Medium

## Committed Artifacts

**2.6MB MP3 Recording in Git:**
- Issue: `recording-2026-04-30T13-51-28.mp3` (2,608,680 bytes) is committed to the repository root. An empty copy also exists in `arquivos-teste/`.
- Files: `recording-2026-04-30T13-51-28.mp3`, `arquivos-teste/recording-2026-04-30T13-51-28.mp3`
- Impact: Bloats git history. Every clone downloads 2.6MB of unnecessary binary data.
- Fix approach: Remove from git with `git rm --cached`. Add `*.mp3` to `.gitignore`. Use `git filter-branch` or BFG Repo Cleaner to purge from history if needed.

**14 Windows Zone.Identifier Files:**
- Issue: NTFS alternate data stream metadata files (`*:Zone.Identifier`) are present in the working tree. Some are tracked by git, others are untracked.
- Files: `js/*.js:Zone.Identifier`, `icons/*.png:Zone.Identifier`, `images/*:Zone.Identifier`, `scripts/*.js:Zone.Identifier`, `recorder.js:Zone.Identifier`
- Impact: Clutters the repository with Windows-specific metadata. May cause confusion on non-Windows systems.
- Fix approach: Add `*:Zone.Identifier` to `.gitignore`. Remove tracked instances with `git rm --cached`.

---

*Concerns audit: 2026-05-31*
