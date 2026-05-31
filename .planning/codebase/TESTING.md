# Testing Patterns

**Analysis Date:** 2026-05-31

## Test Framework

**Runner:** None. No automated test framework is configured.

**Assertion Library:** None.

**Run Commands:**
```bash
# No test runner exists. There are no npm scripts, no jest/vitest/mocha config.
# Manual integration testing is done via shell scripts (see below).
```

## Test File Organization

**Location:** Not applicable — no test files exist in the codebase.

**Naming:** Not applicable.

**Structure:**
```
gravador-reunioes/
├── arquivos-teste/           # Test audio/video fixtures for manual API testing
│   └── recording-*.mp3       # Sample recordings
├── scripts/
│   ├── test-openai-transcriptions.sh      # Manual OpenAI API integration test
│   └── test-assemblyai-transcription.sh   # Manual AssemblyAI API integration test
```

## Existing Test Infrastructure

### Shell Script Integration Tests

Two bash scripts provide manual end-to-end API testing against real transcription services. These are **not** automated — they require API keys as environment variables and real audio files.

**`scripts/test-openai-transcriptions.sh`:**
- Sends audio files from `arquivos-teste/` to the OpenAI Whisper API
- Saves transcription text and raw JSON responses
- Requires: `OPENAI_API_KEY` environment variable
- Usage:
```bash
OPENAI_API_KEY=sk-... bash scripts/test-openai-transcriptions.sh
```

**`scripts/test-assemblyai-transcription.sh`:**
- Uploads audio files to AssemblyAI, polls for completion
- Tests both plain text and diarized transcription modes
- Implements the same fallback logic as the browser code (universal-3-pro → universal-2)
- Requires: `ASSEMBLYAI_API_KEY` environment variable
- Usage:
```bash
ASSEMBLYAI_API_KEY=assemblyai-... bash scripts/test-assemblyai-transcription.sh
```

### Test Fixtures

**`arquivos-teste/`** directory holds sample audio/video files for manual testing:
- `recording-2026-04-30T13-51-28.mp3` (placeholder — 0 bytes)
- Shell scripts glob for `*.mp3`, `*.m4a`, `*.wav`, `*.webm`, `*.mp4`, `*.ogg`

### Auth File Generator

**`scripts/generate-auth-file.js`:**
- Node.js script that generates `captura-acesso.txt` from `captura-acesso.source.txt`
- Uses PBKDF2 with 250,000 iterations for password hashing
- Not a test, but a build-time utility for the authentication system
- Run: `node scripts/generate-auth-file.js`

## Mocking

**Framework:** None.

**Patterns:** Not applicable.

**What to Mock:** When tests are added, the following should be mocked:
- `navigator.mediaDevices.getDisplayMedia()` / `getUserMedia()` — media acquisition
- `AudioContext` and Web Audio API nodes — audio graph
- `window.showDirectoryPicker()` — File System Access API
- `fetch()` — API calls to OpenAI and AssemblyAI
- `indexedDB` — persistence layer
- `localStorage` — preferences
- `crypto.subtle` — authentication hashing
- `HTMLCanvasElement.getContext('2d')` — canvas rendering
- `Worker` — metronome timer

**What NOT to Mock:**
- State machine transition logic (pure logic, testable without mocks)
- Utility functions (`fmtTime`, `fmtBytes`, `dateStamp`, `parseAuthFileRecords`)
- Transcript merging algorithms (`mergeTranscriptText`, `findWordOverlap`)
- Segment normalization (`normalizeStructuredSegments`)

## Fixtures and Factories

**Test Data:** None exist.

**Location:** Not applicable.

## Coverage

**Requirements:** None enforced. No coverage tool is configured.

**View Coverage:**
```bash
# No coverage tooling available
```

## Test Types

**Unit Tests:** None exist.

**Integration Tests:** Manual shell-script API tests only (see above).

**E2E Tests:** Not used. No Playwright, Cypress, or Puppeteer configuration.

## Recommended Testing Approach

When adding tests to this codebase, the following approach aligns with its conventions:

### Framework Selection

Use **Vitest** — it supports ES modules natively without transpilation, matching the codebase's no-build-step philosophy. Configure with `jsdom` or `happy-dom` environment for DOM API access.

### High-Value Testable Modules (no DOM dependencies)

These modules can be unit tested with minimal mocking:

1. **`js/recorder-state-machine.js`** — Pure state transition logic
   - Test all valid transitions from the `TRANSITIONS` table
   - Test invalid transitions are silently ignored
   - Test wildcard error transitions
   - Test `nextState` function routing (e.g., `api.hasSession ? STATE.SESSION : STATE.IDLE`)

2. **`js/prefs.js`** — localStorage wrapper
   - Test `savePref` / `loadPref` with mocked localStorage

3. **`js/storage.js`** — `dateStamp()` utility
   - Test timestamp format output

4. **`js/openai-client.js`** — Error parsing and retry logic
   - Test `shouldRetryTranscriptionError()` with various status codes
   - Test `extractResponseText()` with different API response shapes
   - Test `normalizeTranscriptionSegments()` sorting and filtering
   - Test `createRequestSignal()` timeout and abort behavior

5. **`js/transcription-controller.js`** — Audio processing utilities
   - Test `encodeWavFromFloat32()` WAV header construction
   - Test `mergeTranscriptText()` overlap detection and merging
   - Test `findWordOverlap()` with various inputs
   - Test `formatStructuredTimestamp()` formatting
   - Test `normalizeStructuredSegments()` offset and deduplication
   - Test `buildPrompt()` context truncation

6. **`js/media-library.js`** — File naming logic
   - Test `isMediaFileName()`, `isVideoFileName()`, `isAudioFileName()`
   - Test `isTranscriptNameFor()` variant matching
   - Test `getTranscriptStem()` with variant and suffix options
   - Test `parseMediaMetadata()` and `parseMeetingNotes()` JSON parsing

### Modules Requiring Browser API Mocks

These modules need mocked browser APIs but contain testable logic:

- **`js/audio-mixer.js`** — Audio graph construction (mock `AudioContext`, `GainNode`, `AnalyserNode`)
- **`js/compositor.js`** — Canvas drawing (mock `CanvasRenderingContext2D`)
- **`js/recorder-core.js`** — Mediabunny integration (mock dynamic CDN import)
- **`js/metronome.js`** — Worker-based timer (mock `Worker`, `requestAnimationFrame`)

### Test File Naming Convention

Follow the existing kebab-case file naming:
```
js/recorder-state-machine.test.js
js/prefs.test.js
js/openai-client.test.js
```

Or co-located in a test directory:
```
tests/recorder-state-machine.test.js
tests/openai-client.test.js
```

## Common Patterns

**Async Testing:** Not applicable (no test framework).

**Error Testing:** Not applicable (no test framework).

---

*Testing analysis: 2026-05-31*
