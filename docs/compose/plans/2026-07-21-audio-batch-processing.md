---
published: false
---

# Audio Batch Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a batch audio processing mode that lets users select multiple audio files, define their order, concatenate them, and transcribe as a single file.

**Architecture:** A new `batch-processor.js` module handles audio concatenation via FFmpeg WASM. `media-library.js` gains batch metadata read/write methods. `app.js` manages batch mode UI state and orchestrates the flow. HTML and CSS additions are minimal — a toggle switch and ordered selection panel.

**Tech Stack:** Vanilla JS (ES modules), FFmpeg WASM (already in project), File System Access API, Bootstrap 5 form-check components.

## Global Constraints

- All existing functionality must remain unaffected
- Batch concatenation happens in-browser via FFmpeg WASM (no server)
- Audio files are NOT modified or moved — only read
- Output naming: `lote_DD-MM-YYYY_HHhMMmSSs-transcricao.txt` and `lote_DD-MM-YYYY_HHhMMmSSs-metadados-lote.json`
- Maximum 20 files per batch
- Only audio files are selectable in batch mode (videos disabled)
- Prompt, engine, and mode from the existing panel are reused for the batch

---

### Task 1: Create `batch-processor.js` — audio concatenation module

**Covers:** [S4]

**Files:**
- Create: `js/batch-processor.js`

**Interfaces:**
- Consumes: `FFmpeg` instance (from `@ffmpeg/ffmpeg` CDN, same as `transcription-controller.js`)
- Produces: `concatenateAudioFiles(fileHandles, storageManager, onProgress)` → `Promise<{ blob: Blob, fileName: string }>`

- [ ] **Step 1: Create `js/batch-processor.js`**

```js
// ── batch-processor.js ──────────────────────────────────────────────────────
// Concatenates multiple audio files into a single MP3 blob using FFmpeg WASM.
// The input files are read from File System Access handles, normalized to
// mono 24kHz 64kbps MP3, and concatenated in the order provided.

import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';

const FFMPEG_CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const NORMALIZED_BITRATE = '64k';
const NORMALIZED_SAMPLE_RATE = '24000';

let ffmpegPromise = null;

async function getFfmpeg(onProgress) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onProgress?.({
        stage: 'loading-tools',
        message: 'Carregando o processador de mídia para o lote. Na primeira execução, este download pode levar alguns instantes…',
      });

      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
        classWorkerURL: new URL('./vendor/ffmpeg/worker.js', import.meta.url).href,
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

function getExtension(fileName) {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : 'bin';
}

/**
 * Concatenates multiple audio files into a single MP3 blob.
 * @param {{ name: string, handle: FileSystemFileHandle }[]} files - Files in desired order
 * @param {onProgress} onProgress - Progress callback
 * @returns {Promise<{ blob: Blob, totalDuration: number }>}
 */
export async function concatenateAudioFiles(files, onProgress) {
  if (!files.length) throw new Error('Nenhum arquivo selecionado para concatenação.');

  const ffmpeg = await getFfmpeg(onProgress);
  const normalizedFiles = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const inputName = `input-${i}.${getExtension(file.name)}`;
    const outputName = `norm-${i}.mp3`;

    onProgress?.({
      stage: 'preparing',
      message: `Normalizando arquivo ${i + 1} de ${files.length} (${file.name})…`,
      current: i + 1,
      total: files.length,
    });

    const fileHandle = await file.handle.getFile();
    await ffmpeg.writeFile(inputName, await fetchFile(fileHandle));

    const exitCode = await ffmpeg.exec([
      '-y',
      '-i', inputName,
      '-vn',
      '-ac', '1',
      '-ar', NORMALIZED_SAMPLE_RATE,
      '-b:a', NORMALIZED_BITRATE,
      outputName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Falha ao normalizar ${file.name} (código ${exitCode}).`);
    }

    await ffmpeg.deleteFile(inputName);
    normalizedFiles.push(outputName);
  }

  // Build FFmpeg concat list
  const listContent = normalizedFiles.map(name => `file '${name}'`).join('\n');
  await ffmpeg.writeFile('concat-list.txt', listContent);

  onProgress?.({
    stage: 'concatenating',
    message: `Concatenando ${files.length} arquivos em um único áudio…`,
  });

  const concatExitCode = await ffmpeg.exec([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', 'concat-list.txt',
    '-ac', '1',
    '-ar', NORMALIZED_SAMPLE_RATE,
    '-b:a', NORMALIZED_BITRATE,
    'lote-final.mp3',
  ]);

  if (concatExitCode !== 0) {
    throw new Error(`Falha ao concatenar os arquivos (código ${concatExitCode}).`);
  }

  const resultData = await ffmpeg.readFile('lote-final.mp3');
  const blob = new Blob([resultData], { type: 'audio/mpeg' });

  // Cleanup
  for (const name of normalizedFiles) {
    await ffmpeg.deleteFile(name).catch(() => {});
  }
  await ffmpeg.deleteFile('concat-list.txt').catch(() => {});
  await ffmpeg.deleteFile('lote-final.mp3').catch(() => {});

  return { blob };
}
```

- [ ] **Step 2: Verify the module is syntactically valid**

Run: `node --check js/batch-processor.js`
Expected: No output (no syntax errors). If it fails due to ESM imports, that's expected in Node — the module is designed for browser ESM.

- [ ] **Step 3: Commit**

```bash
git add js/batch-processor.js
git commit -m "feat: add batch audio concatenation module"
```

---

### Task 2: Add batch metadata methods to `media-library.js`

**Covers:** [S5, S6]

**Files:**
- Modify: `js/media-library.js`

**Interfaces:**
- Produces: `writeBatchMetadata(batchData)` → `{ fileName, handle }`
- Produces: `readBatchMetadata(fileName)` → `object | null`
- Produces: `getRelatedBatchTranscripts(mediaFileName)` → `entry[]`
- Produces: `isBatchTranscriptName(name)` → `boolean`

- [ ] **Step 1: Add batch constants near the top of `media-library.js`**

After line 21 (`const LEGACY_TRANSCRIPT_LIVE_SUFFIX = '-transcript-live';`), add:

```js
const BATCH_TRANSCRIPT_SUFFIX = '-transcricao-lote';
const BATCH_METADATA_SUFFIX = '-metadados-lote';
const BATCH_METADATA_EXTENSION = '.json';
```

- [ ] **Step 2: Add batch utility functions**

After the `isTranscriptNameFor` function (after line 92), add:

```js
function isBatchTranscriptNameFor(candidateName) {
  if (!(/\.txt$/i).test(candidateName)) return false;
  return candidateName.startsWith('lote_') && candidateName.includes(TRANSCRIPT_SUFFIX);
}

function getBatchMetadataFileName(batchId) {
  return `${batchId}${BATCH_METADATA_SUFFIX}${BATCH_METADATA_EXTENSION}`;
}
```

- [ ] **Step 3: Add `writeBatchMetadata` method to `MediaLibrary` class**

Inside the `MediaLibrary` class (after `writeTranscriptFile`, around line 403), add:

```js
  async writeBatchMetadata(batchId, metadata) {
    const fileName = getBatchMetadataFileName(batchId);
    const payload = JSON.stringify({
      version: 1,
      ...metadata,
      createdAt: new Date().toISOString(),
    }, null, 2);
    const handle = await this.#storage.writeTextFile(fileName, `${payload}\n`);
    return { fileName, handle };
  }
```

- [ ] **Step 4: Add `readBatchMetadata` method to `MediaLibrary` class**

After `writeBatchMetadata`, add:

```js
  async readBatchMetadata(fileName) {
    const entries = await this.#storage.listDirectoryFileHandles();
    const entry = entries.find(e => e.name === fileName);
    if (!entry) return null;
    const text = await this.#storage.readTextFile(entry.handle);
    try {
      return JSON.parse(text.trim());
    } catch (_) {
      return null;
    }
  }
```

- [ ] **Step 5: Export `isBatchTranscriptNameFor` at the bottom**

At the end of `media-library.js`, after the existing exports, add:

```js
export { isBatchTranscriptNameFor };
```

- [ ] **Step 6: Commit**

```bash
git add js/media-library.js
git commit -m "feat: add batch metadata read/write to MediaLibrary"
```

---

### Task 3: Add batch mode UI to `index.html`

**Covers:** [S3]

**Files:**
- Modify: `index.html`

**Interfaces:**
- Produces: DOM elements `batch-mode-toggle`, `batch-order-panel`, `batch-order-list`, `batch-transcribe-btn`, `batch-count-label`

- [ ] **Step 1: Add batch mode toggle to the detail panel**

In `index.html`, inside `<section id="media-detail-panel">`, before the `<div class="captura-library-detail-grid">` (before line 419), add:

```html
            <div id="batch-mode-control" class="captura-batch-mode-control">
              <label class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="batch-mode-toggle">
                <span class="form-check-label">Modo lote</span>
              </label>
              <p class="captura-side-note mb-0" id="batch-mode-hint">
                Selecione vários áudios para transcrever juntos em um único lote.
              </p>
            </div>
```

- [ ] **Step 2: Add batch order panel inside the detail panel**

After the `captura-engine-actions` div containing the transcribe buttons (after line 438, before `</div>` of `captura-library-detail-grid`), add:

```html
              <div id="batch-order-panel" class="captura-batch-order-panel" hidden>
                <div class="captura-batch-order-header">
                  <span id="batch-count-label" class="captura-batch-count">0 arquivos selecionados</span>
                </div>
                <div id="batch-order-list" class="captura-batch-order-list"></div>
                <div class="captura-engine-actions">
                  <button id="batch-transcribe-btn" class="captura-engine-button" disabled>
                    <i class="fas fa-file-waveform"></i>
                    <span id="batch-transcribe-label">Transcrever lote</span>
                  </button>
                </div>
              </div>
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add batch mode toggle and order panel HTML"
```

---

### Task 4: Add batch mode styles

**Covers:** [S3]

**Files:**
- Modify: `recorder.css`

**Interfaces:**
- Produces: CSS classes for batch mode UI

- [ ] **Step 1: Add batch mode CSS at the end of `recorder.css`**

Open `recorder.css` and append the following styles at the end of the file (before any `@media` queries if they exist at the end, otherwise just append):

```css
/* ── Batch mode ─────────────────────────────────────────────────────────── */

.captura-batch-mode-control {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--captura-border-soft);
}

.captura-batch-mode-control .form-check {
  margin-bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.captura-batch-mode-control .form-check-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--captura-text-muted);
  cursor: pointer;
}

.captura-batch-mode-control .captura-side-note {
  font-size: 0.78rem;
}

.captura-batch-order-panel {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 14px;
  background: var(--captura-surface-soft);
  border: 1px solid var(--captura-border-soft);
}

.captura-batch-order-panel[hidden] {
  display: none;
}

.captura-batch-order-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.captura-batch-count {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--captura-text-muted);
}

.captura-batch-order-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.captura-batch-order-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--captura-surface);
  border: 1px solid var(--captura-border-soft);
  font-size: 0.8rem;
  transition: background 0.15s;
}

.captura-batch-order-item:hover {
  background: var(--captura-surface-elevated);
}

.captura-batch-order-index {
  min-width: 18px;
  text-align: center;
  font-weight: 600;
  color: var(--captura-accent);
  font-size: 0.75rem;
}

.captura-batch-order-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--captura-text);
}

.captura-batch-order-actions {
  display: flex;
  gap: 2px;
}

.captura-batch-order-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--captura-text-muted);
  cursor: pointer;
  font-size: 0.7rem;
  transition: background 0.15s, color 0.15s;
}

.captura-batch-order-btn:hover {
  background: var(--captura-surface-soft);
  color: var(--captura-text);
}

.captura-batch-order-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.captura-library-item .captura-batch-checkbox {
  display: none;
  flex-shrink: 0;
  margin-right: -4px;
}

.captura-library-item .captura-batch-checkbox .form-check-input {
  width: 1.25rem;
  height: 1.25rem;
  cursor: pointer;
}

.captura-batch-mode-active .captura-library-item .captura-batch-checkbox {
  display: flex;
  align-items: center;
}

.captura-batch-mode-active .captura-library-item-shell {
  padding-left: 4px;
}
```

- [ ] **Step 2: Commit**

```bash
git add recorder.css
git commit -m "feat: add batch mode CSS styles"
```

---

### Task 5: Integrate batch mode into `app.js`

**Covers:** [S1, S2, S3, S4, S5, S6, S7]

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `concatenateAudioFiles` from `./batch-processor.js`
- Consumes: `isBatchTranscriptNameFor` from `./media-library.js`
- Produces: Batch mode state management, UI rendering, and transcription orchestration

This is the largest task. It adds state variables, DOM references, rendering logic, and event handlers for batch mode.

- [ ] **Step 1: Add import for `concatenateAudioFiles`**

After line 22 (`import { MediaLibrary, isVideoFileName } from './media-library.js';`), add:

```js
import { concatenateAudioFiles } from './batch-processor.js';
```

- [ ] **Step 2: Add DOM references**

After the existing DOM refs (after line 183, near `postProcessModelInputs`), add:

```js
const batchModeToggle         = document.getElementById('batch-mode-toggle');
const batchModeHintEl         = document.getElementById('batch-mode-hint');
const batchOrderPanelEl       = document.getElementById('batch-order-panel');
const batchOrderListEl        = document.getElementById('batch-order-list');
const batchTranscribeBtn      = document.getElementById('batch-transcribe-btn');
const batchTranscribeLabelEl  = document.getElementById('batch-transcribe-label');
const batchCountLabelEl       = document.getElementById('batch-count-label');
```

- [ ] **Step 3: Add batch mode state variables**

After the existing UI state section (after line 367, `let videoThumbnailQueue = Promise.resolve();`), add:

```js
// ── Batch mode state ─────────────────────────────────────────────────────────
let batchModeEnabled       = false;
let batchSelectedNames     = [];   // ordered list of selected file names
```

- [ ] **Step 4: Add batch mode helper functions**

After the `refreshAdvisoryUi` function (after line 2827), add:

```js
// ── Batch mode helpers ───────────────────────────────────────────────────────

function isAudioEntry(entry) {
  return entry?.kind === 'audio';
}

function getBatchSelectedEntries() {
  return batchSelectedNames
    .map(name => libraryEntries.find(e => e.name === name))
    .filter(Boolean);
}

function renderBatchOrderPanel() {
  if (!batchOrderPanelEl || !batchOrderListEl || !batchCountLabelEl) return;

  const entries = getBatchSelectedEntries();
  batchOrderPanelEl.hidden = entries.length < 2;
  batchCountLabelEl.textContent = `${entries.length} arquivo${entries.length === 1 ? '' : 's'} selecionado${entries.length === 1 ? '' : 's'}`;
  batchOrderListEl.replaceChildren();

  if (entries.length < 2) return;

  entries.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'captura-batch-order-item';
    item.dataset.name = entry.name;

    const idx = document.createElement('span');
    idx.className = 'captura-batch-order-index';
    idx.textContent = `${index + 1}`;

    const name = document.createElement('span');
    name.className = 'captura-batch-order-name';
    name.textContent = entry.name;
    name.title = entry.name;

    const actions = document.createElement('div');
    actions.className = 'captura-batch-order-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'captura-batch-order-btn';
    upBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
    upBtn.title = 'Mover para cima';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      if (index > 0) {
        const temp = batchSelectedNames[index];
        batchSelectedNames[index] = batchSelectedNames[index - 1];
        batchSelectedNames[index - 1] = temp;
        renderBatchOrderPanel();
        renderMediaFileList();
      }
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'captura-batch-order-btn';
    downBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
    downBtn.title = 'Mover para baixo';
    downBtn.disabled = index === entries.length - 1;
    downBtn.addEventListener('click', () => {
      if (index < entries.length - 1) {
        const temp = batchSelectedNames[index];
        batchSelectedNames[index] = batchSelectedNames[index + 1];
        batchSelectedNames[index + 1] = temp;
        renderBatchOrderPanel();
        renderMediaFileList();
      }
    });

    actions.append(upBtn, downBtn);
    item.append(idx, name, actions);
    batchOrderListEl.append(item);
  });
}

function updateBatchTranscribeButton() {
  const count = batchSelectedNames.length;
  if (batchTranscribeLabelEl) {
    batchTranscribeLabelEl.textContent = count >= 2
      ? `Transcrever lote (${count} arquivos)`
      : 'Transcrever lote';
  }
  if (batchTranscribeBtn) {
    batchTranscribeBtn.disabled = count < 2 || transcriptionBusy || postProcessingBusy;
  }
}

function toggleBatchMode(enabled) {
  batchModeEnabled = enabled;
  if (!enabled) {
    batchSelectedNames = [];
  }
  document.querySelector('.captura-library-file-list')?.classList?.toggle('captura-batch-mode-active', enabled);
  if (batchModeHintEl) {
    batchModeHintEl.textContent = enabled
      ? 'Selecione vários áudios para transcrever juntos em um único lote.'
      : 'Selecione vários áudios para transcrever juntos em um único lote.';
  }
  renderBatchOrderPanel();
  updateBatchTranscribeButton();
  renderMediaFileList();
}

function toggleBatchSelection(name) {
  const index = batchSelectedNames.indexOf(name);
  if (index >= 0) {
    batchSelectedNames.splice(index, 1);
  } else {
    if (batchSelectedNames.length >= 20) {
      showToast('Limite de 20 arquivos por lote.', 'warning');
      return;
    }
    batchSelectedNames.push(name);
  }
  renderBatchOrderPanel();
  updateBatchTranscribeButton();
  renderMediaFileList();
}
```

- [ ] **Step 5: Update `buildMediaListItem` to add batch checkboxes**

In the `buildMediaListItem` function (around line 1813), after the `const shell = document.createElement('div');` and its className assignment (line 1824), add the checkbox before `iconBox`:

Find:
```js
  const shell = document.createElement('div');
  shell.className = 'captura-library-item-shell';
```

Replace with:
```js
  const shell = document.createElement('div');
  shell.className = 'captura-library-item-shell';

  const batchCheckbox = document.createElement('div');
  batchCheckbox.className = 'captura-batch-checkbox';
  if (batchModeEnabled) {
    const input = document.createElement('input');
    input.className = 'form-check-input';
    input.type = 'checkbox';
    input.checked = batchSelectedNames.includes(entry.name);
    input.disabled = !isAudioEntry(entry);
    input.title = isAudioEntry(entry) ? 'Incluir no lote' : 'Vídeos não podem ser incluídos no lote';
    input.addEventListener('click', event => {
      event.stopPropagation();
      if (isAudioEntry(entry)) toggleBatchSelection(entry.name);
    });
    batchCheckbox.appendChild(input);
  }
```

Then find where `shell.append(iconBox, body);` (around line 1948) and replace with:

```js
  shell.append(batchCheckbox, iconBox, body);
```

- [ ] **Step 6: Update `renderMediaFileList` to handle batch mode active class**

In `renderMediaFileList` (around line 1953), after `mediaFileListEl.replaceChildren();`, add:

```js
  mediaFileListEl.classList.toggle('captura-batch-mode-active', batchModeEnabled);
```

- [ ] **Step 7: Add `renderBatchTranscribeButton` call in `render()`**

In the `render` function (around line 2524), after the existing `transcribeNewVersionBtn` block (around line 2586), add:

```js
  updateBatchTranscribeButton();
```

- [ ] **Step 8: Add batch transcription function**

After the `transcribeSelectedMedia` function (after line 2278), add:

```js
async function transcribeBatch() {
  const entries = getBatchSelectedEntries();
  if (entries.length < 2) return;

  const engineValue = getSelectedTranscriptionEngine();
  const baseEngine = getBaseEngine(engineValue);
  const engineLabel = getSelectedEngineDisplayLabel(engineValue);
  const speechModels = baseEngine === TRANSCRIPTION_ENGINES.assemblyai ? getAssemblyAiSpeechModels(engineValue) : null;
  const mode = getTranscriptionMode();
  const modeLabel = TRANSCRIPTION_OUTPUT_MODE_LABELS[mode] || TRANSCRIPTION_OUTPUT_MODE_LABELS.plain;

  try {
    getTranscriptionClient(baseEngine).assertConfigured();
  } catch (error) {
    handleTranscriptionError(error, {
      toast: false,
      dialog: true,
      updateTranscriptPane: true,
      updateLivePane: true,
    });
    return;
  }

  transcriptionBusy = true;
  renderMediaFileList();
  render(machine.state);
  setTranscriptionStatus(
    `Concatenando ${entries.length} áudios e transcrevendo em lote com ${engineLabel}…`,
    'muted',
    { active: true }
  );

  try {
    // Concatenate
    const { blob } = await concatenateAudioFiles(entries, payload => {
      reportTranscriptionProgress(payload);
    });

    const batchId = `lote_${dateStamp()}`;
    const combinedFile = new File([blob], `${batchId}.mp3`, { type: 'audio/mpeg' });

    // Transcribe the concatenated file
    setTranscriptionStatus(
      `Enviando lote de ${entries.length} arquivos para ${engineLabel}…`,
      'muted',
      { active: true }
    );

    const result = await transcriptionController.transcribeFile(combinedFile, {
      prompt: getFileTranscriptionPrompt(),
      engine: baseEngine,
      speechModels,
      mode,
      onProgress: payload => {
        reportTranscriptionProgress(payload);
      },
    });

    // Save transcript
    const transcriptFileName = `${batchId}-transcricao.txt`;
    const handle = await storage.writeTextFile(transcriptFileName, `${result.text.trim()}\n`);

    // Save batch metadata
    await mediaLibrary.writeBatchMetadata(batchId, {
      files: entries.map((e, i) => ({ name: e.name, order: i + 1 })),
      engine: engineValue,
      mode,
      transcriptFileName,
    });

    showToast(`Transcrição em lote salva como ${transcriptFileName}.`, 'success');
    setTranscriptionStatus(`Transcrição em lote salva como ${transcriptFileName}.`, 'success');

    // Exit batch mode
    batchModeEnabled = false;
    batchSelectedNames = [];
    if (batchModeToggle) batchModeToggle.checked = false;
    toggleBatchMode(false);

    await refreshMediaLibrary({ silent: true });
  } catch (error) {
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: true,
      updateLivePane: true,
    });
  } finally {
    transcriptionBusy = false;
    renderMediaFileList();
    render(machine.state);
  }
}
```

- [ ] **Step 9: Add event listeners for batch mode**

In the event listeners section (after line 3203, near the `authGateFormEl` listener), add:

```js
batchModeToggle?.addEventListener('change', () => {
  toggleBatchMode(batchModeToggle.checked);
  trackEvent('captura_pref_change', { pref: 'batch_mode', value: String(batchModeToggle.checked) });
});

batchTranscribeBtn?.addEventListener('click', () => {
  void transcribeBatch();
});
```

- [ ] **Step 10: Verify the module loads without errors**

Open the app in a browser, open DevTools console, verify no errors on load. Toggle batch mode on/off. Select 2+ audio files and verify the order panel appears.

- [ ] **Step 11: Commit**

```bash
git add js/app.js
git commit -m "feat: integrate batch mode into app UI and transcription flow"
```

---

### Task 6: Final verification and cleanup

**Covers:** [S7]

**Files:**
- No new files

- [ ] **Step 1: Verify existing functionality is unaffected**

Open the app and verify:
1. Single-file transcription still works
2. Meeting notes still work
3. Post-processing still works
4. Recording still works
5. Batch mode toggle appears and functions correctly
6. Selecting audio files in batch mode shows order panel
7. Reordering works (up/down buttons)
8. Transcribing a batch produces a file with `lote_` prefix
9. Batch metadata JSON is saved alongside

- [ ] **Step 2: Commit any final fixes**

```bash
git add -A
git commit -m "fix: final adjustments for batch processing feature"
```
