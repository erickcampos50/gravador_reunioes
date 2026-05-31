# Coding Conventions

**Analysis Date:** 2026-05-31

## Language & Runtime

**Language:** Vanilla JavaScript (ES2022+)
**Runtime:** Browser-only (no Node.js build step, no bundler)
**Module system:** Native ES Modules (`import`/`export`)
**Entry point:** `index.html` loads `js/app.js` via `<script type="module">`

There is no TypeScript, no JSX, no transpilation, and no build toolchain. All source files are served directly to the browser.

## Naming Patterns

**Files:**
- kebab-case: `recorder-core.js`, `audio-mixer.js`, `transcription-controller.js`
- Vendor files retain original casing: `js/vendor/ffmpeg/worker.js`

**Classes:**
- PascalCase: `RecorderCore`, `AudioMixer`, `RecorderStateMachine`, `TranscriptionController`
- One class per file (except `js/openai-client.js` which exports multiple related classes)

**Functions:**
- camelCase: `startTimer()`, `buildMix()`, `extractPostProcessResponseText()`
- Private methods use `#` prefix: `#drawMeter()`, `#startLoop()`, `#flushChunk()`
- Factory/helper functions at module scope: `fmtTime()`, `fmtBytes()`, `dateStamp()`

**Constants:**
- UPPER_SNAKE_CASE at module scope: `BLOB_URL_REVOKE_TIMEOUT_MS`, `FORMAT_MP3`, `AUDIO_BITRATE`
- Frozen enums via `Object.freeze()`: `STATE`, `EVENT` in `js/recorder-state-machine.js`
- Map-style constants: `STATUS_CLASS`, `VIDEO_BITRATES`, `RESOLUTION_CONSTRAINTS`

**Variables:**
- camelCase: `elapsedSecs`, `selectedMediaEntry`, `meetingNotesDirty`
- Module-level mutable state declared with `let`: `let elapsedSecs = 0;`
- DOM references as `const` with descriptive suffixes: `startBtn`, `micSel`, `timerEl`, `canvas`

**Private class fields:**
- ES2022 `#` private fields used extensively (not `_` prefix convention)
- Example from `js/audio-mixer.js`:
```javascript
#audioCtx      = null;
#audioDestNode = null;
#mixedStream   = null;
#micGainNode   = null;
```

## Code Style

**Formatting:**
- No formatter configured (no Prettier, Biome, or .editorconfig)
- Indentation: 2 spaces throughout all `js/` source files
- `scripts/formatting.js` uses 4 spaces (legacy blog script, different codebase origin)
- Trailing semicolons: always present
- Single quotes for strings (except `scripts/formatting.js` which uses double quotes)

**Linting:**
- No linter configured (no ESLint, Biome, or equivalent)
- Code quality enforced by manual review and consistent authorship

**Line length:**
- No enforced limit; long lines are common in UI string construction and fetch calls
- Complex expressions broken across multiple lines with aligned indentation

## Module Structure

**Header comment pattern:**
Every module begins with a block comment describing its role:
```javascript
// ── recorder-core.js ──────────────────────────────────────────────────────────
// The Mediabunny Wrapper: ties canvas frames and a mixed audio track to a
// FileSystemWritableFileStream via WebCodecs hardware encode + mux.
// Responsibilities:
//   • Lazily import Mediabunny from CDN (browser caches after first load).
//   • Build the Output / CanvasSource / MediaStreamAudioTrackSource graph.
//   • Expose start(), addFrame(), pause(), resume(), and finalize() so that
//     app.js can drive the encode pipeline without knowing the Mediabunny API.
```

**Section dividers:**
Modules use `// ── Section Name ──` comments to separate logical sections:
```javascript
// ── Constants ──────────────────────────────────────────────────────────────────
// ── DOM refs ───────────────────────────────────────────────────────────────────
// ── Engine instances ───────────────────────────────────────────────────────────
// ── UI state ───────────────────────────────────────────────────────────────────
// ── Private helpers ──────────────────────────────────────────────────────────
```

**Class structure order:**
1. Private fields (`#field`)
2. Constructor
3. Public getters
4. Public methods (grouped by responsibility)
5. Private methods (`#methodName`)

## Import Organization

**Order:**
1. Local module imports (relative paths)
2. No external package imports (no node_modules)
3. CDN imports via dynamic `import()` or static URL strings

**Pattern:**
```javascript
import { AudioMixer }                            from './audio-mixer.js';
import { Compositor }                            from './compositor.js';
import { RecorderCore }                          from './recorder-core.js';
import { PREFS, savePref, loadPref }             from './prefs.js';
import { showAlert, showToast, showErrorDialog } from './dialogs.js';
```

**Alignment:** Import specifiers are column-aligned with extra spaces for visual grouping.

**Path aliases:** None. All imports use relative paths with `.js` extension.

**CDN imports:** External libraries loaded via CDN URLs, not npm:
```javascript
// Dynamic import (lazy loaded)
const MEDIABUNNY_CDN = 'https://cdn.jsdelivr.net/npm/mediabunny@1.40.1/+esm';
const { Output, CanvasSource } = await import(MEDIABUNNY_CDN);

// Static import from CDN
import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
```

## Error Handling

**Strategy:** Thrown `Error` objects with Portuguese (Brazilian) messages. No error boundary framework.

**Patterns:**

1. **Custom error classes** for domain-specific errors:
```javascript
// js/openai-client.js
export class OpenAIConfigError extends TranscriptionConfigError { ... }
export class AssemblyAIConfigError extends TranscriptionConfigError { ... }
class OpenAIRequestError extends Error {
  constructor(message, { status, model, requestId, cause } = {}) { ... }
}
```

2. **Error.name for flow control** — distinguish user-cancel from real errors:
```javascript
if (err.name === 'AbortError' || err.name === 'NotAllowedError') {
  machine.transition(EVENT.STREAMS_FAILED, err);
} else {
  machine.transition(EVENT.ENCODER_ERROR, err);
}
```

3. **Custom error.name for UI differentiation:**
```javascript
const err = new Error('O áudio do sistema não foi capturado...');
err.name  = 'SysAudioNotCaptured';
err.title = 'Áudio do Sistema Não Capturado';
throw err;
```

4. **Silent catch for optional operations** — preview metering, analytics, clipboard:
```javascript
} catch (_) {
  // Preview metering is optional — silently ignore permission errors, etc.
}
```

5. **try/catch/finally for resource cleanup:**
```javascript
try {
  const response = await fetch(url, { signal: requestSignal });
  // ...
} catch (error) {
  if (timedOut()) throw new Error('...');
  throw error;
} finally {
  cleanup();
}
```

6. **Error propagation to UI** via callback injection:
```javascript
// StorageManager receives onError callback to avoid DOM coupling
constructor(dirNameEl, onError) {
  this.#onError = onError;  // (title, message) => void
}
```

## Logging

**Framework:** `console.error` and `console.warn` only. No structured logging library.

**Patterns:**
- `console.error('[RecorderStateMachine] Unhandled effect error:', err)` — prefixed with module name
- `console.warn('IndexedDB put failed:', e)` — non-critical failures
- Most errors surfaced to the user via `showErrorDialog()` or `showToast()` rather than logged

## Comments

**When to comment:**
- Module-level responsibility block (mandatory — every module has one)
- Section dividers for logical grouping
- "Why" explanations for non-obvious decisions (e.g., silent WAV for macOS Core Audio workaround)
- Parameter documentation in method signatures via inline comments

**JSDoc/TSDoc:**
- Not used. No `@param`, `@returns`, or `@type` annotations.
- Parameter documentation done via inline comments above methods:
```javascript
// canvas          – HTMLCanvasElement whose pixels are encoded each frame.
// mixedAudioTrack – MediaStreamTrack from the mixed audio graph, or null.
// writableStream  – FileSystemWritableFileStream opened by StorageManager.
```

## Function Design

**Size:** Functions range from 1-line arrow helpers to ~100-line UI renderers. `js/app.js` has several functions exceeding 50 lines due to DOM manipulation.

**Parameters:**
- Destructured object parameters for complex signatures:
```javascript
async init({ canvas, mixedAudioTrack, writableStream, outputKind, videoBitrate }) { ... }
async ensureAccess({ mode = 'readwrite', silent = false, requestIfNeeded = true } = {}) { ... }
```
- Positional parameters for simple signatures:
```javascript
buildMix(sysAudioTracks, micStream, micGainValue, sysGainValue) { ... }
setMicGain(value) { ... }
```

**Return values:**
- Async functions return Promises; use `async`/`await` throughout
- Boolean returns for success/failure: `ensureAccess()` returns `true`/`false`
- Object returns for multi-value results: `{ fileName, handle }`

**Arrow functions:**
- Used for short module-level helpers:
```javascript
const gainPct = v => Math.round(parseFloat(v) * 100) + '%';
const fmtTime = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const isMp3Format = format => format === FORMAT_MP3;
```
- Full `function` keyword used for anything with multiple statements or `this` binding concerns

## Module Design

**Exports:**
- Named exports only. No default exports anywhere in the codebase.
- Classes exported directly: `export class RecorderCore { ... }`
- Functions exported individually: `export function showAlert(msgOrNode, type) { ... }`
- Constants exported when shared: `export const PREFS = { ... }`

**Barrel files:** Not used. Each module is imported directly by path.

**Module coupling:**
- `js/app.js` is the composition root — imports all engines and wires them together
- Engine modules (`audio-mixer.js`, `compositor.js`, `recorder-core.js`, `storage.js`, `metronome.js`) have zero DOM access
- `js/recorder-api.js` mediates between engines with no DOM references
- `js/recorder-state-machine.js` has no DOM access; side-effects delegate to `RecorderAPI`
- `js/dialogs.js` owns DOM access for alerts/toasts/modals
- `js/prefs.js` is a pure utility module (localStorage wrapper)

## Dependency Injection

**Pattern:** Constructor injection for all engine instances.

```javascript
// js/app.js — composition root
const compositor = new Compositor(canvas, { onPipMoved: (x, y) => { ... } });
const audioMixer = new AudioMixer(micLevelCanvas, sysLevelCanvas);
const storage    = new StorageManager(dirNameEl, showErrorDialog);
const api        = new RecorderAPI({ compositor, audioMixer, metronome, recorderCore, storage, canvas });
const machine    = new RecorderStateMachine(api);
```

## State Management

**Pattern:** Module-level mutable variables in `js/app.js` (no state management library).

```javascript
let elapsedSecs               = 0;
let libraryEntries            = [];
let selectedMediaEntry        = null;
let meetingNotesDirty           = false;
const selectedTranscriptNameByMedia = new Map();
```

**Recording lifecycle:** Finite-state machine in `js/recorder-state-machine.js` with explicit states (`IDLE`, `REQUESTING`, `RECORDING`, `PAUSED`, `STOPPING`, `SESSION`, `ERROR`) and event-driven transitions.

**Preferences:** `localStorage` via `js/prefs.js` helpers (`savePref`, `loadPref`) with `PREFS` key constants.

**Persistence:** IndexedDB for directory handle persistence in `js/storage.js`.

## UI Language

**All user-facing strings are in Brazilian Portuguese (pt-BR):**
- Error messages: `'Não foi possível carregar o arquivo.'`
- UI labels: `'Escolher pasta'`, `'Iniciar gravação'`
- Toast messages: `'Transcrição salva com sucesso.'`
- HTML lang attribute: `<html lang="pt-BR">`

## CSS Conventions

**Framework:** Bootstrap 5.3.3 via CDN
**Custom styles:** `recorder.css` (42K, main app styles) + `styles/styles.css` (35 lines, global overrides)
**Icons:** Font Awesome 6.5.2 via CDN
**Fonts:** Inter via Google Fonts
**Custom class prefix:** `captura-` (e.g., `captura-shell`, `captura-auth-screen`, `captura-library-entry`)

---

*Convention analysis: 2026-05-31*
