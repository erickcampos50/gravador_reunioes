// ── app.js ────────────────────────────────────────────────────────────────────
// The UI layer.
// Responsibilities:
//   • Create engine instances and wire them into RecorderAPI + RecorderStateMachine.
//   • Render the correct button / badge / selector state for each machine state.
//   • Dispatch state machine events from user interactions.
//   • Manage the elapsed-time timer and OS media session.
//   • Enumerate devices, manage preferences, and bootstrap the page.

import { AudioMixer }                            from './audio-mixer.js';
import { Compositor }                            from './compositor.js';
import { Metronome }                             from './metronome.js';
import { StorageManager }                        from './storage.js';
import { RecorderCore }                          from './recorder-core.js';
import { PREFS, savePref, loadPref }             from './prefs.js';
import { showAlert, showToast, showErrorDialog } from './dialogs.js';
import { setupMediaSession, clearMediaSession }  from './media-session.js';
import { registerServiceWorker }                 from './register-service-worker.js';
import { RecorderAPI }                           from './recorder-api.js';
import { RecorderStateMachine, STATE, EVENT }    from './recorder-state-machine.js';
import { trackEvent }                            from './analytics.js';
import { MediaLibrary, isVideoFileName }         from './media-library.js';
import {
  AssemblyAIClientManager,
  AssemblyAIConfigError,
  ASSEMBLYAI_SPEECH_MODELS,
  DEFAULT_POSTPROCESS_MODEL,
  DeepSeekClientManager,
  DeepSeekConfigError,
  getAssemblyAiSpeechModels,
  getBaseEngine,
  isDeepSeekPostProcessModel,
  OpenAIClientManager,
  OpenAIConfigError,
  POSTPROCESS_MODELS,
  TRANSCRIPTION_ENGINES,
  TRANSCRIPTION_ENGINE_LABELS,
  TRANSCRIPTION_OUTPUT_MODES,
  TRANSCRIPTION_OUTPUT_MODE_LABELS,
} from './openai-client.js';
import { TranscriptionController }               from './transcription-controller.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const BLOB_URL_REVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const FORMAT_MP3                 = 'mp3-audio-only';
const AUDIO_BITRATE              = 128_000;
const VIDEO_BITRATES             = { '480': 2_000_000, '720': 4_000_000, '1080': 8_000_000 };
const ONE_HOUR_SECONDS           = 60 * 60;
const LIBRARY_DATE_FORMATTER     = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const STATUS_CLASS = {
  muted:   'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
};
const DEFAULT_POSTPROCESS_PROMPT = 'Reescreva a transcrição em português do Brasil, com clareza, boa fluidez e preservando o sentido original. Retorne apenas o texto final.';
const POSTPROCESS_PROMPT_PRESETS = {
  meeting_minutes: 'Reescreva esta transcrição como uma ata de reunião em português do Brasil. Estruture em: contexto, participantes citados quando identificáveis, decisões tomadas, pendências, responsáveis e próximos passos. Use linguagem objetiva e profissional.',
  legal: 'Reescreva esta transcrição em linguagem jurídica formal, técnica e impessoal, em português do Brasil. Preserve o conteúdo original, elimine ambiguidades, organize os fatos com clareza e utilize terminologia compatível com documentos jurídicos.',
  executive_summary: 'Reescreva esta transcrição como um resumo executivo em português do Brasil. Destaque objetivo, principais pontos discutidos, decisões, riscos, oportunidades e próximos passos em linguagem clara e concisa.',
};
const POSTPROCESS_RESULT_SUFFIX = 'reformulado';
const AUTH_FILE_NAME = 'captura-acesso.txt';
const AUTH_SESSION_KEY = 'captura-auth-session';
const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_DERIVED_BYTES = 32;
const AUTH_GATE_DESCRIPTION = 'O acesso fica salvo por 30 dias neste navegador.';
const VIDEO_THUMBNAIL_WIDTH = 156;
const VIDEO_THUMBNAIL_HEIGHT = 116;
const VIDEO_THUMBNAIL_TIMEOUT_MS = 7000;

// ── Formatters ─────────────────────────────────────────────────────────────────

const gainPct = v => Math.round(parseFloat(v) * 100) + '%';
const fmtTime = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const fmtBytes = bytes => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(decimals) + ' ' + units[unitIndex];
};
const isMp3Format = format => format === FORMAT_MP3;

// ── DOM refs ───────────────────────────────────────────────────────────────────

const recorderUi     = document.getElementById('recorder-ui');
const transcriptionUi = document.getElementById('transcription-ui');
const canvas         = document.getElementById('recorder-canvas');
const webcamSel      = document.getElementById('webcam-select');
const micSel         = document.getElementById('mic-select');
const fpsSel         = document.getElementById('fps-select');
const qualitySel     = document.getElementById('quality-select');
const formatSel      = document.getElementById('format-select');
const sysAudioChk    = document.getElementById('sys-audio-chk');
const startBtn       = document.getElementById('start-btn');
const pauseBtn       = document.getElementById('pause-btn');
const stopBtn        = document.getElementById('stop-btn');
const micToggleBtn   = document.getElementById('mic-toggle-btn');
const endSessionBtn  = document.getElementById('end-session-btn');
const pickDirBtn     = document.getElementById('pick-dir-btn');
const dirNameEl      = document.getElementById('dir-name');
const statusBadge    = document.getElementById('status-badge');
const timerEl        = document.getElementById('timer-text');
const recordingEstimateEl = document.getElementById('recording-estimate');
const formatHintEl        = document.getElementById('format-hint');
const longRecordingAlertEl = document.getElementById('long-recording-alert');
const micGainSlider  = document.getElementById('mic-gain-slider');
const sysGainSlider  = document.getElementById('sys-gain-slider');
const micGainLabel   = document.getElementById('mic-gain-label');
const sysGainLabel   = document.getElementById('sys-gain-label');
const micLevelCanvas = document.getElementById('mic-level-canvas');
const sysLevelCanvas = document.getElementById('sys-level-canvas');
const errorDialog    = document.getElementById('captura-error-dialog');

const openAiPanel            = document.getElementById('openai-panel');
const assemblyAiPanel        = document.getElementById('assemblyai-panel');
const deepSeekPanel          = document.getElementById('deepseek-panel');
const openAiKeyForm          = document.getElementById('openai-key-form');
const openAiApiKeyInput      = document.getElementById('openai-api-key');
const openAiApiKeyToggleBtn  = document.getElementById('openai-api-key-toggle');
const assemblyAiKeyForm      = document.getElementById('assemblyai-key-form');
const assemblyAiApiKeyInput  = document.getElementById('assemblyai-api-key');
const assemblyAiApiKeyToggleBtn = document.getElementById('assemblyai-api-key-toggle');
const deepSeekKeyForm        = document.getElementById('deepseek-key-form');
const deepSeekApiKeyInput    = document.getElementById('deepseek-api-key');
const deepSeekApiKeyToggleBtn = document.getElementById('deepseek-api-key-toggle');
const liveTranscriptionChk   = document.getElementById('live-transcription-chk');
const transcriptionPromptEl  = document.getElementById('transcription-prompt');
const transcriptionModeSel   = document.getElementById('transcription-mode-select');
const transcriptionModeHintEl = document.getElementById('transcription-mode-hint');
const transcriptionStatusEl  = document.getElementById('transcription-status');
const liveTranscriptOutputEl = document.getElementById('live-transcript-output');
const liveTranscriptBadgeEl  = document.getElementById('live-transcript-badge');
const authGateEl             = document.getElementById('auth-gate');
const authGateFormEl         = document.getElementById('auth-gate-form');
const authGateDescriptionEl  = document.getElementById('auth-gate-description');
const authGateStatusEl       = document.getElementById('auth-gate-status');
const authPasswordInputEl    = document.getElementById('auth-password-input');
const authSubmitBtn          = document.getElementById('auth-submit-btn');
const appShellEl             = document.querySelector('.captura-shell');
const meetingNotesPanelEl    = document.getElementById('meeting-notes-panel');
const meetingNotesStatusEl   = document.getElementById('meeting-notes-status');
const meetingNotesAddBtn     = document.getElementById('meeting-notes-add-btn');
const meetingNotesPrefixBtn   = document.getElementById('meeting-notes-prefix-btn');
const meetingNotesPrefixHelpEl = document.getElementById('meeting-notes-prefix-help');
const meetingNotesPostProcessChk = document.getElementById('meeting-notes-postprocess-chk');
const meetingNotesPostProcessControlEl = document.getElementById('meeting-notes-postprocess-control');
const meetingNotesPostProcessHintEl = document.getElementById('meeting-notes-postprocess-hint');
const meetingNotesListEl     = document.getElementById('meeting-notes-list');
const refreshLibraryBtn      = document.getElementById('refresh-library-btn');
const mediaFileListEl        = document.getElementById('media-file-list');
const mediaDetailPanelEl     = document.getElementById('media-detail-panel');
const librarySummaryEl       = document.getElementById('library-summary');
const selectedVideoPlayerEl  = document.getElementById('selected-video-player');
const selectedAudioPlayerEl  = document.getElementById('selected-audio-player');
const mediaPreviewPlaceholderEl = document.getElementById('media-preview-placeholder');
const transcribeSelectedBtn  = document.getElementById('transcribe-selected-btn');
const transcribeNewVersionBtn = document.getElementById('transcribe-new-version-btn');
const transcriptVersionSel   = document.getElementById('transcript-version-select');
const selectedTranscriptStatusEl = document.getElementById('selected-transcript-status');
const transcriptViewerEl     = document.getElementById('transcript-viewer');
const transcriptEditBtn      = document.getElementById('transcript-edit-btn');
const processSelectedTranscriptBtn = document.getElementById('process-selected-transcript-btn');
const postProcessStatusEl    = document.getElementById('postprocess-status');
const postProcessPresetSel   = document.getElementById('postprocess-preset-select');
const postProcessPromptEl    = document.getElementById('postprocess-prompt');
const postProcessOutputEl    = document.getElementById('postprocess-output');
const postProcessCopyBtn     = document.getElementById('postprocess-copy-btn');
const postProcessSaveBtn     = document.getElementById('postprocess-save-btn');
const transcriptionEngineInputs = Array.from(document.querySelectorAll('input[name="transcription-engine"]'));
const postProcessModelInputs = Array.from(document.querySelectorAll('input[name="postprocess-model"]'));

// ── Capability checks ──────────────────────────────────────────────────────────

const hasGetDisplayMedia = !!(navigator.mediaDevices?.getDisplayMedia);
const hasFSA             = typeof window.showDirectoryPicker === 'function';

// ── Engine instances ───────────────────────────────────────────────────────────

const compositor = new Compositor(canvas, {
  onPipMoved: (x, y) => { savePref(PREFS.pipX, x); savePref(PREFS.pipY, y); },
});

const metronome      = new Metronome();
const audioMixer     = new AudioMixer(micLevelCanvas, sysLevelCanvas);
const storage        = new StorageManager(dirNameEl, showErrorDialog);
const recorderCore   = new RecorderCore();
const openAiClient   = new OpenAIClientManager(openAiApiKeyInput);
const assemblyAiClient = new AssemblyAIClientManager(assemblyAiApiKeyInput);
const deepSeekClient = new DeepSeekClientManager(deepSeekApiKeyInput);
const mediaLibrary   = new MediaLibrary(storage);
const transcriptionClients = {
  [TRANSCRIPTION_ENGINES.openai]: openAiClient,
  [TRANSCRIPTION_ENGINES.assemblyai]: assemblyAiClient,
};
const transcriptionController = new TranscriptionController({
  getClientManager: engine => transcriptionClients[engine] || transcriptionClients[TRANSCRIPTION_ENGINES.assemblyai],
  mediaLibrary,
  onLiveUpdate: ({ text }) => {
    liveTranscriptOutputEl.value = text;
    setTranscriptionStatus('Transcrição ao vivo atualizada.', 'success');
    setLiveTranscriptBadge('Ouvindo', 'badge bg-success');
  },
  onStatus: payload => {
    if (payload?.message) setTranscriptionStatus(payload.message, 'muted');
  },
  onError: error => {
    setTranscriptionStatus(error.message || 'Falha na transcrição ao vivo.', 'danger');
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
  },
});

function extractPostProcessResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data?.output)) return '';

  const parts = [];
  data.output.forEach(item => {
    if (!Array.isArray(item?.content)) return;
    item.content.forEach(contentItem => {
      if (typeof contentItem?.text === 'string' && contentItem.text.trim()) {
        parts.push(contentItem.text.trim());
      }
    });
  });

  return parts.join('\n\n').trim();
}

async function fallbackPostProcessText({ text, prompt = '', signal, model = DEFAULT_POSTPROCESS_MODEL } = {}) {
  const apiKey = openAiClient.assertConfigured();
  const transcriptText = text?.trim() || '';
  if (!transcriptText) {
    throw new Error('Não há texto de transcrição para processar.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'Você reescreve transcrições. Retorne apenas o texto final reformulado, sem prefácio, sem título e sem observações extras, a menos que isso seja pedido explicitamente.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Instrução:\n${prompt.trim() || DEFAULT_POSTPROCESS_PROMPT}`,
                `Transcrição:\n${transcriptText}`,
              ].join('\n\n'),
            },
          ],
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    let message = `A requisição para a OpenAI falhou com status ${response.status}.`;
    try {
      const data = await response.json();
      message = data?.error?.message || data?.message || message;
    } catch (_) {
      message = await response.text().catch(() => message);
    }
    throw new Error(message);
  }

  const data = await response.json();
  const outputText = extractPostProcessResponseText(data);
  if (!outputText) {
    throw new Error('A OpenAI retornou um resultado vazio no pós-processamento.');
  }

  return outputText;
}

function getPostProcessClient(model = DEFAULT_POSTPROCESS_MODEL) {
  return isDeepSeekPostProcessModel(model) ? deepSeekClient : openAiClient;
}

const postProcessText = params => {
  const client = getPostProcessClient(params?.model);
  return typeof client?.postProcessText === 'function'
    ? client.postProcessText(params)
    : fallbackPostProcessText(params);
};

// ── API + state machine ────────────────────────────────────────────────────────

const api = new RecorderAPI({
  compositor, audioMixer, metronome, recorderCore, storage, canvas,
});

const machine = new RecorderStateMachine(api);

// ── UI state ───────────────────────────────────────────────────────────────────

let elapsedSecs               = 0;
let timerIntervalId           = null;
let libraryEntries            = [];
let selectedMediaEntry        = null;
let selectedTranscriptEntries = [];
let selectedTranscriptRawText = '';
let selectedMediaNotesInfo    = null;
let selectedPreviewUrl        = null;
let pendingLiveStopPromise    = Promise.resolve('');
let recordingTranscriptInFlight = false;
let transcriptionBusy         = false;
let postProcessingBusy        = false;
const selectedTranscriptNameByMedia = new Map();
const postProcessResultsByTranscript = new Map();
let meetingNotesSessionFileName = '';
let meetingNotesSessionActive   = false;
let meetingNotesEntries         = [];
let meetingNotesDirty           = false;
let meetingNotesSaving          = false;
let meetingNotesQueuedSave      = false;
let meetingNotesSaveTimerId     = null;
let meetingNotesUiLocked        = true;
let meetingNotesPostProcessLocked = true;
let meetingNotesSavePromise     = Promise.resolve();
let meetingNotesPrefixEnabled   = false;
const meetingNotesPostProcessByMedia = new Map();
let selectedMediaNotesLoading   = false;
let transcriptEditingEnabled    = false;
let transcriptEditSaveQueue     = Promise.resolve();
let transcriptEditSaveSequence  = 0;
let authLoadPromise             = null;
let authRecords                 = [];
let authFingerprint            = '';
let authUnlocked               = false;
let authBootstrapDone          = false;
let authSubmitPending          = false;
let pageViewTracked            = false;
let deviceChangeListenerAttached = false;
const videoThumbnailCache      = new Map();
const videoThumbnailPromises   = new Map();
let videoThumbnailQueue        = Promise.resolve();

// ── Timer state ────────────────────────────────────────────────────────────────

function startTimer() {
  clearInterval(timerIntervalId);
  elapsedSecs = 0;
  timerEl.textContent = '00:00';
  updateRecordingEstimate();
  timerIntervalId = setInterval(() => {
    timerEl.textContent = fmtTime(++elapsedSecs);
    updateRecordingEstimate();
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerIntervalId);
  timerIntervalId = null;
  updateRecordingEstimate();
}

function resumeTimer() {
  if (!timerIntervalId) {
    timerIntervalId = setInterval(() => {
      timerEl.textContent = fmtTime(++elapsedSecs);
      updateRecordingEstimate();
    }, 1000);
  }
}

function resetTimer() {
  clearInterval(timerIntervalId);
  timerIntervalId = null;
  elapsedSecs = 0;
  timerEl.textContent = '00:00';
  updateRecordingEstimate();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setInlineStatus(el, message, tone = 'muted') {
  if (!el) return;
  const isProcessStatus = el.id === 'transcription-status';
  el.textContent = message;
  el.className = `captura-inline-status small ${STATUS_CLASS[tone] || STATUS_CLASS.muted}`;
  if (isProcessStatus) el.classList.add('captura-process-status');
}

function setTranscriptionStatus(message, tone = 'muted', { active = false } = {}) {
  setInlineStatus(transcriptionStatusEl, message, tone);
  transcriptionStatusEl?.classList.toggle('is-active', active);
  transcriptionStatusEl?.setAttribute('aria-busy', String(active));
}

function setSelectedTranscriptStatus(message, tone = 'muted') {
  setInlineStatus(selectedTranscriptStatusEl, message, tone);
}

function setPostProcessStatus(message, tone = 'muted') {
  setInlineStatus(postProcessStatusEl, message, tone);
}

function reportTranscriptionProgress(payload, { includeSelected = false } = {}) {
  if (!payload?.message) return;
  setTranscriptionStatus(payload.message, 'muted', { active: true });
  if (includeSelected) setSelectedTranscriptStatus(payload.message, 'muted');
}

function setLiveTranscriptBadge(label, className) {
  liveTranscriptBadgeEl.textContent = label;
  liveTranscriptBadgeEl.className = className;
}

function openOpenAiPanel() {
  openAiPanel.open = true;
  savePref(PREFS.openAiPanelOpen, 'true');
}

function openAssemblyAiPanel() {
  assemblyAiPanel.open = true;
  savePref(PREFS.assemblyAiPanelOpen, 'true');
}

function openDeepSeekPanel() {
  deepSeekPanel.open = true;
  savePref(PREFS.deepSeekPanelOpen, 'true');
}

function getSelectedTranscriptionEngine() {
  const selected = transcriptionEngineInputs.find(input => input.checked);
  return selected?.value || TRANSCRIPTION_ENGINES.assemblyai;
}

function getSelectedPostProcessModel() {
  const selected = postProcessModelInputs.find(input => input.checked);
  return POSTPROCESS_MODELS.includes(selected?.value) ? selected.value : DEFAULT_POSTPROCESS_MODEL;
}

function getTranscriptionClient(engine = getSelectedTranscriptionEngine()) {
  return transcriptionClients[engine] || transcriptionClients[TRANSCRIPTION_ENGINES.assemblyai];
}

function getSelectedEngineLabel(engine = getSelectedTranscriptionEngine()) {
  return TRANSCRIPTION_ENGINE_LABELS[engine] || engine;
}

function getSelectedEngineDisplayLabel(engine = getSelectedTranscriptionEngine()) {
  return TRANSCRIPTION_ENGINE_LABELS[engine] || engine;
}

function getSupportedTranscriptionModes(client = getTranscriptionClient()) {
  return client?.supportedModes instanceof Set
    ? client.supportedModes
    : new Set(Object.values(TRANSCRIPTION_OUTPUT_MODES));
}

function isTranscriptionModeSupported(mode, client = getTranscriptionClient()) {
  return getSupportedTranscriptionModes(client).has(mode);
}

function getTranscriptionMode() {
  return transcriptionModeSel?.value || TRANSCRIPTION_OUTPUT_MODES.plain;
}

function isDiarizationTranscriptionMode() {
  return getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.diarized;
}

function getLiveTranscriptionPrompt() {
  return getTranscriptionClient()?.supportsPrompt === false
    ? ''
    : transcriptionPromptEl.value.trim();
}

function getFileTranscriptionPrompt() {
  if (getTranscriptionClient()?.supportsPrompt === false) return '';
  return isDiarizationTranscriptionMode() ? '' : transcriptionPromptEl.value.trim();
}

function isLiveTranscriptionEnabled() {
  return liveTranscriptionChk.checked;
}

function updateTranscriptionUiCapabilities() {
  const client = getTranscriptionClient();
  const supportedModes = getSupportedTranscriptionModes(client);
  const supportsPrompt = client?.supportsPrompt !== false;
  const isOpenAi = getSelectedTranscriptionEngine() === TRANSCRIPTION_ENGINES.openai;

  Array.from(transcriptionModeSel.options).forEach(option => {
    option.disabled = !supportedModes.has(option.value);
  });

  if (!supportedModes.has(getTranscriptionMode())) {
    transcriptionModeSel.value = supportedModes.has(TRANSCRIPTION_OUTPUT_MODES.plain)
      ? TRANSCRIPTION_OUTPUT_MODES.plain
      : Array.from(supportedModes)[0] || TRANSCRIPTION_OUTPUT_MODES.plain;
    savePref(PREFS.transcriptionMode, transcriptionModeSel.value);
  }

  const promptLabel = transcriptionPromptEl.closest('label.captura-field');
  if (promptLabel) promptLabel.hidden = !isOpenAi;

  transcriptionPromptEl.placeholder = supportsPrompt
    ? 'Ex.: Preserve termos técnicos, siglas, nomes próprios e contexto específico desta mídia durante a transcrição.'
    : 'Disponível quando o motor OpenAI estiver selecionado.';
}

function updateTranscriptionModeHint() {
  if (!transcriptionModeHintEl) return;

  const client = getTranscriptionClient();
  const engineLabel = getSelectedEngineLabel();
  if (client?.engine === TRANSCRIPTION_ENGINES.assemblyai) {
    transcriptionModeHintEl.textContent =
      getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.diarized
        ? 'Usa AssemblyAI com rótulos dos participantes por turno.'
        : 'AssemblyAI fica em texto normal aqui e mantém a diarização disponível quando você precisar.';
    return;
  }

  transcriptionModeHintEl.textContent =
    getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.timestamps
      ? 'Gera um texto legível com timestamps por segmento.'
      : getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.diarized
        ? 'Gera rótulos dos participantes por segmento. Neste modo, o prompt de transcrição é ignorado apenas no fluxo de arquivo.'
        : 'Mantém a transcrição em texto simples, como hoje.';
}

function updatePostProcessActionButtons({ lockControls = false } = {}) {
  const hasOutput = !!postProcessOutputEl.value.trim();
  if (postProcessCopyBtn) postProcessCopyBtn.disabled = lockControls || !hasOutput;
  if (postProcessSaveBtn) postProcessSaveBtn.disabled = lockControls || !hasOutput;
}

// ── Authentication gate ───────────────────────────────────────────────────────

const authTextEncoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(text) {
  try {
    const binary = atob(text.trim());
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (_) {
    return null;
  }
}

function normalizeAuthFileText(text = '') {
  return String(text || '').replace(/\r\n/g, '\n');
}

function parseAuthFileRecords(rawText) {
  return normalizeAuthFileText(rawText)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map((line, index) => {
      const parts = line.split('|');
      if (parts.length < 4) return null;

      const label = parts[0].trim() || `acesso-${index + 1}`;
      const iterations = Number(parts[1]);
      const salt = base64ToBytes(parts[2]);
      const hash = base64ToBytes(parts[3]);

      if (!Number.isInteger(iterations) || iterations <= 0 || !salt || !hash) {
        return null;
      }

      return {
        label,
        iterations,
        salt,
        hash,
      };
    })
    .filter(Boolean);
}

async function digestAuthFileText(rawText) {
  const digest = await crypto.subtle.digest('SHA-256', authTextEncoder.encode(normalizeAuthFileText(rawText)));
  return bytesToHex(new Uint8Array(digest));
}

async function deriveAuthPasswordHash(password, record) {
  const key = await crypto.subtle.importKey(
    'raw',
    authTextEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: record.salt,
      iterations: record.iterations,
    },
    key,
    AUTH_DERIVED_BYTES * 8
  );

  return new Uint8Array(bits);
}

function constantTimeEquals(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

async function verifyAuthPassword(password, records = authRecords) {
  const candidate = typeof password === 'string' ? password.trim() : '';
  if (!candidate || !Array.isArray(records) || !records.length) {
    return null;
  }

  for (const record of records) {
    const derived = await deriveAuthPasswordHash(candidate, record);
    if (constantTimeEquals(derived, record.hash)) {
      return record;
    }
  }

  return null;
}

function loadAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.fingerprint !== 'string') return null;
    if (!Number.isFinite(parsed.expiresAt)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function saveAuthSession() {
  if (!authFingerprint) return;

  try {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
      version: 1,
      fingerprint: authFingerprint,
      expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
    }));
  } catch (_) {}
}

function clearAuthSession() {
  try {
    localStorage.removeItem(AUTH_SESSION_KEY);
  } catch (_) {}
}

function isAuthSessionValid(session, fingerprint = '') {
  return !!session
    && typeof session.fingerprint === 'string'
    && Number.isFinite(session.expiresAt)
    && session.expiresAt > Date.now()
    && (!fingerprint || session.fingerprint === fingerprint);
}

function setAuthStatus(message, tone = 'muted') {
  if (!authGateStatusEl) return;
  authGateStatusEl.textContent = message;
  authGateStatusEl.className = `captura-inline-status small ${STATUS_CLASS[tone] || STATUS_CLASS.muted}`;
}

function setAuthInteractive(interactive) {
  if (authPasswordInputEl) authPasswordInputEl.disabled = !interactive;
  if (authSubmitBtn) authSubmitBtn.disabled = !interactive;
}

function showAuthGate(message = AUTH_GATE_DESCRIPTION, tone = 'muted', interactive = true) {
  authUnlocked = false;
  if (authGateEl) authGateEl.hidden = false;
  if (appShellEl) appShellEl.hidden = true;
  document.body.classList.add('captura-auth-locked');

  if (authGateDescriptionEl) authGateDescriptionEl.textContent = AUTH_GATE_DESCRIPTION;
  setAuthStatus(message, tone);
  setAuthInteractive(interactive);

  if (interactive && authPasswordInputEl) {
    authPasswordInputEl.focus();
    authPasswordInputEl.select?.();
  }
}

function showMainApp() {
  if (authGateEl) authGateEl.hidden = true;
  if (appShellEl) appShellEl.hidden = false;
  document.body.classList.remove('captura-auth-locked');
}

function trackPageViewOnce() {
  if (pageViewTracked) return;
  pageViewTracked = true;
  trackEvent('captura_page_view', {
    has_screen_capture:  hasGetDisplayMedia,
    has_file_system_api: hasFSA,
  });
}

async function loadAuthRecords() {
  if (!authLoadPromise) {
    authLoadPromise = (async () => {
      const response = await fetch(`./${AUTH_FILE_NAME}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Não foi possível carregar ${AUTH_FILE_NAME} (HTTP ${response.status}).`);
      }

      const rawText = await response.text();
      const records = parseAuthFileRecords(rawText);
      if (!records.length) {
        throw new Error(`Nenhuma senha válida foi encontrada em ${AUTH_FILE_NAME}.`);
      }

      const fingerprint = await digestAuthFileText(rawText);
      authRecords = records;
      authFingerprint = fingerprint;
      return { records, fingerprint, rawText };
    })().catch(error => {
      authLoadPromise = null;
      throw error;
    });
  }

  return authLoadPromise;
}

async function postAuthBootstrap() {
  if (authBootstrapDone) return;
  authBootstrapDone = true;

  trackPageViewOnce();

  if (hasGetDisplayMedia && !deviceChangeListenerAttached) {
    deviceChangeListenerAttached = true;
    navigator.mediaDevices.addEventListener('devicechange', enumerateDevices);
    void enumerateDevices();
  }

  api.restartPreviews();
  await initializeStorageAndLibrary();
  render(machine.state);
}

async function unlockApplication() {
  if (!authFingerprint) {
    throw new Error('Não foi possível confirmar o acesso porque o arquivo de senhas não foi carregado.');
  }

  authUnlocked = true;
  saveAuthSession();
  showMainApp();
  setAuthStatus('Acesso liberado. Carregando a ferramenta…', 'success');
  setAuthInteractive(false);
  await postAuthBootstrap();
}

async function initializeAuthentication() {
  showAuthGate('Verificando acesso salvo…', 'muted', false);

  const rememberedSession = loadAuthSession();
  const rememberedSessionValid = isAuthSessionValid(rememberedSession);

  try {
    await loadAuthRecords();
  } catch (error) {
    if (rememberedSessionValid) {
      authFingerprint = rememberedSession.fingerprint;
      authRecords = [];
      try {
        await unlockApplication();
        return;
      } catch (unlockError) {
        clearAuthSession();
        showAuthGate(unlockError.message || 'Não foi possível validar o acesso salvo.', 'danger', true);
        return;
      }
    }

    showAuthGate(error.message || `Não foi possível carregar ${AUTH_FILE_NAME}.`, 'danger', false);
    return;
  }

  if (rememberedSessionValid) {
    if (rememberedSession.fingerprint === authFingerprint) {
      try {
        await unlockApplication();
        return;
      } catch (error) {
        clearAuthSession();
        showAuthGate(error.message || 'Não foi possível validar o acesso salvo.', 'danger', true);
        return;
      }
    }

    clearAuthSession();
  } else if (rememberedSession) {
    clearAuthSession();
  }

  showAuthGate(AUTH_GATE_DESCRIPTION, 'muted', true);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (authSubmitPending) return;

  const password = authPasswordInputEl?.value || '';
  if (!password.trim()) {
    setAuthStatus('Digite uma senha para continuar.', 'danger');
    authPasswordInputEl?.focus();
    return;
  }

  authSubmitPending = true;
  setAuthStatus('Verificando senha…', 'muted');
  setAuthInteractive(false);

  try {
    const match = await verifyAuthPassword(password, authRecords);
    if (!match) {
      if (authPasswordInputEl) authPasswordInputEl.value = '';
      setAuthStatus('Senha incorreta. Tente novamente.', 'danger');
      setAuthInteractive(true);
      authPasswordInputEl?.focus();
      return;
    }

    await unlockApplication();
  } catch (error) {
    setAuthStatus(error.message || 'Não foi possível validar a senha.', 'danger');
    setAuthInteractive(true);
    authPasswordInputEl?.focus();
  } finally {
    authSubmitPending = false;
  }
}

async function copyTextToClipboard(text) {
  if (!text.trim()) throw new Error('Não há texto para copiar.');

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  helper.style.pointerEvents = 'none';
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand('copy');
  helper.remove();

  if (!copied) {
    throw new Error('Não foi possível copiar o texto para a área de transferência.');
  }
}

async function savePostProcessOutput() {
  const output = postProcessOutputEl.value.trim();
  if (!output) {
    throw new Error('Não há resultado reformulado para salvar.');
  }
  if (!selectedMediaEntry?.name) {
    throw new Error('Selecione um arquivo de mídia antes de salvar o resultado reformulado.');
  }

  const dirOk = await storage.ensureAccess({
    mode: 'readwrite',
    silent: false,
    requestIfNeeded: true,
  });
  if (!dirOk) {
    throw new Error('A pasta escolhida não está disponível para salvar o resultado reformulado.');
  }

  const result = await mediaLibrary.writeTranscript(selectedMediaEntry.name, output, {
    suffix: POSTPROCESS_RESULT_SUFFIX,
  });

  showToast(`Resultado salvo como ${result.fileName}.`, 'success');
  setPostProcessStatus(`Resultado salvo como ${result.fileName}.`, 'success');
  return result;
}

function revokeSelectedPreviewUrl() {
  if (!selectedPreviewUrl) return;
  URL.revokeObjectURL(selectedPreviewUrl);
  selectedPreviewUrl = null;
}

function hideMediaDetailPanel() {
  if (mediaDetailPanelEl) mediaDetailPanelEl.hidden = true;
}

function resetMediaPreview() {
  revokeSelectedPreviewUrl();
  [selectedVideoPlayerEl, selectedAudioPlayerEl].forEach(mediaEl => {
    mediaEl.pause();
    mediaEl.removeAttribute('src');
    mediaEl.load();
    mediaEl.hidden = true;
  });
  mediaPreviewPlaceholderEl.hidden = false;
}

function getVideoThumbnailCacheKey(entry) {
  return `${entry.name}:${entry.size || 0}:${entry.lastModified || 0}`;
}

function waitForMediaEvent(mediaEl, eventName, timeoutMs = VIDEO_THUMBNAIL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timerId);
      mediaEl.removeEventListener(eventName, handleEvent);
      mediaEl.removeEventListener('error', handleError);
    };
    const handleEvent = () => { cleanup(); resolve(); };
    const handleError = () => {
      cleanup();
      reject(new Error('Não foi possível carregar o vídeo para gerar a miniatura.'));
    };
    const timerId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout ao carregar preview do vídeo (${eventName}).`));
    }, timeoutMs);

    mediaEl.addEventListener(eventName, handleEvent, { once: true });
    mediaEl.addEventListener('error', handleError, { once: true });
  });
}

async function seekVideoForThumbnail(videoEl) {
  if (videoEl.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitForMediaEvent(videoEl, 'loadedmetadata');
  }

  const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  const seekTime = duration > 2 ? Math.min(1, duration / 4) : 0;
  if (seekTime > 0) {
    const seeked = waitForMediaEvent(videoEl, 'seeked');
    videoEl.currentTime = seekTime;
    await seeked;
    return;
  }

  if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForMediaEvent(videoEl, 'loadeddata');
  }
}

function drawVideoThumbnail(videoEl) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = VIDEO_THUMBNAIL_WIDTH;
  canvasEl.height = VIDEO_THUMBNAIL_HEIGHT;
  const ctx = canvasEl.getContext('2d');
  const sourceWidth = videoEl.videoWidth || VIDEO_THUMBNAIL_WIDTH;
  const sourceHeight = videoEl.videoHeight || VIDEO_THUMBNAIL_HEIGHT;
  const scale = Math.max(VIDEO_THUMBNAIL_WIDTH / sourceWidth, VIDEO_THUMBNAIL_HEIGHT / sourceHeight);
  const cropWidth = VIDEO_THUMBNAIL_WIDTH / scale;
  const cropHeight = VIDEO_THUMBNAIL_HEIGHT / scale;
  const cropX = Math.max(0, (sourceWidth - cropWidth) / 2);
  const cropY = Math.max(0, (sourceHeight - cropHeight) / 2);

  ctx.fillStyle = '#050607';
  ctx.fillRect(0, 0, VIDEO_THUMBNAIL_WIDTH, VIDEO_THUMBNAIL_HEIGHT);
  ctx.drawImage(
    videoEl,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    VIDEO_THUMBNAIL_WIDTH,
    VIDEO_THUMBNAIL_HEIGHT
  );
  return canvasEl.toDataURL('image/jpeg', 0.74);
}

async function generateVideoThumbnail(entry) {
  const file = await entry.handle.getFile();
  const objectUrl = URL.createObjectURL(file);
  const videoEl = document.createElement('video');

  try {
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.preload = 'metadata';
    videoEl.src = objectUrl;
    await seekVideoForThumbnail(videoEl);
    return drawVideoThumbnail(videoEl);
  } finally {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    URL.revokeObjectURL(objectUrl);
  }
}

function ensureVideoThumbnail(entry) {
  const cacheKey = getVideoThumbnailCacheKey(entry);
  if (videoThumbnailCache.has(cacheKey)) return Promise.resolve(videoThumbnailCache.get(cacheKey));
  if (videoThumbnailPromises.has(cacheKey)) return videoThumbnailPromises.get(cacheKey);

  const promise = videoThumbnailQueue
    .then(() => generateVideoThumbnail(entry))
    .then(thumbnailUrl => {
      videoThumbnailCache.set(cacheKey, thumbnailUrl);
      videoThumbnailPromises.delete(cacheKey);
      return thumbnailUrl;
    })
    .catch(error => {
      videoThumbnailPromises.delete(cacheKey);
      throw error;
    });

  videoThumbnailQueue = promise.catch(() => {});
  videoThumbnailPromises.set(cacheKey, promise);
  return promise;
}

function setVideoThumbnailPreview(thumbEl, thumbnailUrl, fileName) {
  const imageEl = document.createElement('img');
  imageEl.src = thumbnailUrl;
  imageEl.alt = `Prévia de ${fileName}`;
  imageEl.loading = 'lazy';

  const playBadge = document.createElement('span');
  playBadge.className = 'captura-library-thumb-badge';
  playBadge.innerHTML = '<i class="fas fa-play"></i>';

  thumbEl.classList.remove('is-loading');
  thumbEl.classList.add('has-preview');
  thumbEl.replaceChildren(imageEl, playBadge);
}

function loadVideoThumbnailInto(thumbEl, entry) {
  const cacheKey = getVideoThumbnailCacheKey(entry);
  thumbEl.dataset.thumbnailKey = cacheKey;

  const cached = videoThumbnailCache.get(cacheKey);
  if (cached) {
    setVideoThumbnailPreview(thumbEl, cached, entry.name);
    return;
  }

  thumbEl.classList.add('is-loading');
  ensureVideoThumbnail(entry)
    .then(thumbnailUrl => {
      if (thumbEl.dataset.thumbnailKey === cacheKey) {
        setVideoThumbnailPreview(thumbEl, thumbnailUrl, entry.name);
      }
    })
    .catch(() => {
      if (thumbEl.dataset.thumbnailKey === cacheKey) {
        thumbEl.classList.remove('is-loading');
      }
    });
}

function clearTranscriptViewer(message = 'A transcrição selecionada será exibida aqui.') {
  transcriptViewerEl.value = '';
  transcriptViewerEl.placeholder = message;
}

function getSelectedTranscriptEntry() {
  const transcriptName = transcriptVersionSel.value;
  return selectedTranscriptEntries.find(entry => entry.name === transcriptName) || null;
}

function clearPostProcessCacheForTranscript(mediaName = selectedMediaEntry?.name || '', transcriptName = transcriptVersionSel.value) {
  if (!mediaName || !transcriptName) return;
  const keyPrefix = `${mediaName}::${transcriptName}::`;
  Array.from(postProcessResultsByTranscript.keys()).forEach(key => {
    if (key.startsWith(keyPrefix)) postProcessResultsByTranscript.delete(key);
  });
}

function updateTranscriptEditUi({ lockControls = false } = {}) {
  const canEdit = !!getSelectedTranscriptEntry() && !lockControls;
  transcriptEditBtn.disabled = !canEdit;
  transcriptEditBtn.textContent = transcriptEditingEnabled ? 'Concluir' : 'Editar';
  transcriptEditBtn.setAttribute('aria-pressed', String(transcriptEditingEnabled));
  transcriptEditBtn.title = transcriptEditingEnabled
    ? 'Concluir a edição direta da transcrição.'
    : 'Editar diretamente o arquivo .txt da transcrição selecionada.';
  transcriptViewerEl.readOnly = !transcriptEditingEnabled || lockControls;
  transcriptViewerEl.classList.toggle('is-editing', transcriptEditingEnabled && !lockControls);
}

function stopTranscriptEditing({ renderViewer = true } = {}) {
  if (!transcriptEditingEnabled) {
    updateTranscriptEditUi();
    return;
  }

  transcriptEditSaveSequence += 1;
  transcriptEditingEnabled = false;
  transcriptViewerEl.readOnly = true;
  transcriptViewerEl.classList.remove('is-editing');
  if (renderViewer) renderSelectedTranscriptViewer();
  updateTranscriptEditUi();
}

async function startTranscriptEditing() {
  const transcriptEntry = getSelectedTranscriptEntry();
  if (!transcriptEntry) return;

  const dirOk = await storage.ensureAccess({
    mode: 'readwrite',
    silent: false,
    requestIfNeeded: true,
  });
  if (!dirOk) {
    throw new Error('A pasta escolhida não está disponível para editar a transcrição.');
  }

  transcriptEditingEnabled = true;
  transcriptViewerEl.value = selectedTranscriptRawText;
  transcriptViewerEl.placeholder = 'Edite a transcrição. Cada alteração será salva no arquivo selecionado.';
  updateTranscriptEditUi();
  setSelectedTranscriptStatus(`Editando ${transcriptEntry.name}. Cada alteração será salva no arquivo.`, 'muted');
  transcriptViewerEl.focus();
  transcriptViewerEl.setSelectionRange(transcriptViewerEl.value.length, transcriptViewerEl.value.length);
}

async function toggleTranscriptEditing() {
  if (transcriptEditingEnabled) {
    stopTranscriptEditing();
    return;
  }

  await startTranscriptEditing();
}

function queueTranscriptEditSave() {
  if (!transcriptEditingEnabled) return;
  const transcriptEntry = getSelectedTranscriptEntry();
  if (!transcriptEntry) return;

  const fileName = transcriptEntry.name;
  const nextText = transcriptViewerEl.value;
  const saveSequence = ++transcriptEditSaveSequence;
  selectedTranscriptRawText = nextText;
  clearPostProcessCacheForTranscript();
  syncPostProcessOutput();
  setSelectedTranscriptStatus(`Salvando edição em ${fileName}…`, 'muted');

  transcriptEditSaveQueue = transcriptEditSaveQueue
    .catch(() => {})
    .then(async () => {
      const result = await mediaLibrary.writeTranscriptFile(fileName, nextText);
      transcriptEntry.handle = result.handle;
      if (saveSequence === transcriptEditSaveSequence) {
        setSelectedTranscriptStatus(`Edição salva em ${fileName}.`, 'success');
      }
    })
    .catch(error => {
      if (saveSequence === transcriptEditSaveSequence) {
        stopTranscriptEditing({ renderViewer: false });
        handleTranscriptionError(error, {
          toast: true,
          dialog: false,
          updateTranscriptPane: true,
          updateLivePane: false,
        });
      }
    });
}

function formatMeetingTimePrefix(seconds) {
  return `[${fmtTime(Math.max(0, Math.floor(Number(seconds) || 0)))}]`;
}

function getMeetingNotesItems(notesInfo = selectedMediaNotesInfo) {
  return Array.isArray(notesInfo?.notes) ? notesInfo.notes : [];
}

function hasMeetingNotes(notesInfo = selectedMediaNotesInfo) {
  return getMeetingNotesItems(notesInfo).some(note => note?.text?.trim());
}

function formatMeetingNoteForDisplay(note) {
  const text = note?.text?.trim() || '';
  if (!text) return '';
  return note.includeMeetingTime
    ? `${formatMeetingTimePrefix(note.meetingTimeSeconds)} ${text}`
    : text;
}

function getSelectedMediaNotesCacheToken() {
  if (!hasMeetingNotes(selectedMediaNotesInfo)) return 'notes-empty';
  const fileName = selectedMediaNotesInfo?.fileName || selectedMediaNotesInfo?.mediaFileName || '';
  const lastModified = selectedMediaNotesInfo?.lastModified || 0;
  const notesCount = getMeetingNotesItems(selectedMediaNotesInfo).filter(note => note?.text?.trim()).length;
  return `${fileName}:${lastModified}:${notesCount}`;
}

const MEETING_NOTES_SECTION_HEADER = '=== NOTAS DA REUNIÃO ===';
const TRANSCRIPT_SECTION_HEADER = '=== TRANSCRIÇÃO ===';

function buildMeetingNotesSectionText(notesInfo = selectedMediaNotesInfo) {
  const notes = getMeetingNotesItems(notesInfo)
    .map(formatMeetingNoteForDisplay)
    .filter(Boolean);

  if (!notes.length) return '';
  return [MEETING_NOTES_SECTION_HEADER, ...notes].join('\n\n');
}

function buildTranscriptSectionText(transcriptText = selectedTranscriptRawText) {
  const body = transcriptText.trim();
  if (!body) return '';
  return [TRANSCRIPT_SECTION_HEADER, body].join('\n\n');
}

function buildCombinedTranscriptText({
  includeNotes = true,
  notesInfo = selectedMediaNotesInfo,
  transcriptText = selectedTranscriptRawText,
} = {}) {
  const sections = [];
  if (includeNotes) {
    const notesSection = buildMeetingNotesSectionText(notesInfo);
    if (notesSection) sections.push(notesSection);
  }

  const transcriptSection = buildTranscriptSectionText(transcriptText);
  if (transcriptSection) sections.push(transcriptSection);

  return sections.join('\n\n');
}

function buildTranscriptViewerText(transcriptText = selectedTranscriptRawText, notesInfo = selectedMediaNotesInfo) {
  return buildCombinedTranscriptText({
    includeNotes: true,
    notesInfo,
    transcriptText,
  });
}

function getMeetingNotesPostProcessEnabled(mediaName = selectedMediaEntry?.name || '') {
  if (!mediaName) return false;
  return meetingNotesPostProcessByMedia.get(mediaName) === true;
}

function setMeetingNotesPostProcessEnabled(mediaName, enabled) {
  if (!mediaName) return;
  if (enabled) {
    meetingNotesPostProcessByMedia.set(mediaName, true);
  } else {
    meetingNotesPostProcessByMedia.delete(mediaName);
  }
}

function buildTranscriptProcessingText() {
  const transcriptText = selectedTranscriptRawText.trim();
  const mediaName = selectedMediaEntry?.name || '';
  const notesIncluded = getMeetingNotesPostProcessEnabled(mediaName) && hasMeetingNotes();
  return buildCombinedTranscriptText({
    includeNotes: notesIncluded,
    notesInfo: selectedMediaNotesInfo,
    transcriptText,
  });
}

function getMediaEventEmptyText() {
  return 'Clique para registrar informação complementar';
}

function renderMediaEventField(fieldEl, entry) {
  const description = entry.eventDescription?.trim() || '';
  fieldEl.classList.toggle('is-empty', !description);
  fieldEl.classList.remove('is-editing');
  fieldEl.contentEditable = 'false';
  fieldEl.textContent = description || getMediaEventEmptyText();
  fieldEl.title = description || 'Clique para registrar a informação complementar deste arquivo.';
}

function beginMediaEventEdit(fieldEl, entry) {
  if (fieldEl.classList.contains('is-editing')) return;

  fieldEl.classList.add('is-editing');
  fieldEl.contentEditable = 'true';
  fieldEl.textContent = entry.eventDescription?.trim() || '';
  fieldEl.focus();

  const selection = window.getSelection?.();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(fieldEl);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

async function saveMediaEventEdit(fieldEl, entry) {
  if (!entry?.name) return;

  const nextValue = fieldEl.textContent.trim();
  const previousValue = entry.eventDescription?.trim() || '';
  fieldEl.classList.remove('is-editing');
  fieldEl.contentEditable = 'false';

  if (nextValue === previousValue) {
    renderMediaEventField(fieldEl, entry);
    return;
  }

  try {
    const dirOk = await storage.ensureAccess({
      mode: 'readwrite',
      silent: false,
      requestIfNeeded: true,
    });
    if (!dirOk) {
      renderMediaEventField(fieldEl, entry);
      return;
    }

    const result = await mediaLibrary.writeMediaEventInfo(entry.name, nextValue);
    entry.eventDescription = nextValue;
    const libraryEntry = libraryEntries.find(item => item.name === entry.name);
    if (libraryEntry) libraryEntry.eventDescription = nextValue;
    renderMediaFileList();
    showToast(
      nextValue
        ? `Informação complementar salva em ${result.fileName}.`
        : `Informação complementar removida de ${result.fileName}.`,
      'success'
    );
  } catch (error) {
    renderMediaEventField(fieldEl, entry);
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: false,
    });
  }
}

function getSelectedTranscriptCacheKey(mediaName = selectedMediaEntry?.name || '', transcriptName = transcriptVersionSel.value) {
  if (!mediaName || !transcriptName) return '';
  const notesToken = getMeetingNotesPostProcessEnabled(mediaName) && hasMeetingNotes(selectedMediaNotesInfo)
    ? getSelectedMediaNotesCacheToken()
    : 'notes-off';
  return `${mediaName}::${transcriptName}::${notesToken}`;
}

function syncPostProcessOutput() {
  const cacheKey = getSelectedTranscriptCacheKey();
  if (!cacheKey) {
    postProcessOutputEl.value = '';
    postProcessOutputEl.placeholder = 'O resultado processado aparecerá aqui.';
    setPostProcessStatus('Escolha uma transcrição salva para habilitar o pós-processamento.', 'muted');
    updatePostProcessActionButtons();
    return;
  }

  const cached = postProcessResultsByTranscript.get(cacheKey) || '';
  postProcessOutputEl.value = cached;
  postProcessOutputEl.placeholder = 'O resultado processado aparecerá aqui.';
  updatePostProcessActionButtons();
  setPostProcessStatus(
    cached
      ? 'Exibindo o último texto reformulado desta versão da transcrição.'
      : getMeetingNotesPostProcessEnabled()
        ? 'Adicione um prompt opcional e processe a transcrição selecionada com as notas da reunião incluídas.'
        : 'Adicione um prompt opcional e processe a transcrição selecionada.',
    cached ? 'success' : 'muted'
  );
}

function clearSelectedMediaState(message = 'Selecione um arquivo da pasta escolhida para visualizar e inspecionar a transcrição e a informação complementar.') {
  stopTranscriptEditing({ renderViewer: false });
  selectedMediaEntry = null;
  selectedTranscriptEntries = [];
  selectedTranscriptRawText = '';
  selectedMediaNotesInfo = null;
  selectedMediaNotesLoading = false;
  resetMediaPreview();
  mediaPreviewPlaceholderEl.textContent = message;
  transcriptVersionSel.innerHTML = '<option value="">Nenhuma transcrição ainda</option>';
  transcriptVersionSel.disabled = true;
  clearTranscriptViewer();
  updateTranscriptEditUi();
  setSelectedTranscriptStatus('Selecione um arquivo para carregar a transcrição.', 'muted');
  postProcessOutputEl.value = '';
  updatePostProcessActionButtons();
  setPostProcessStatus('Escolha um arquivo e uma versão da transcrição para executar o pós-processamento.', 'muted');
  renderMeetingNotesPanel();
  syncMeetingNotesPostProcessControl();
  hideMediaDetailPanel();
}

function createMeetingNoteId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getMeetingNotesCanEdit() {
  return !!meetingNotesSessionActive && !!meetingNotesSessionFileName;
}

function createMeetingNoteEntry({
  text = '',
  meetingTimeSeconds = elapsedSecs,
  includeMeetingTime = meetingNotesPrefixEnabled,
} = {}) {
  const timestamp = new Date().toISOString();
  return {
    id: createMeetingNoteId(),
    text: typeof text === 'string' ? text : '',
    meetingTimeSeconds: Math.max(0, Math.floor(Number(meetingTimeSeconds) || 0)),
    includeMeetingTime: !!includeMeetingTime,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeMeetingNotesEntries(notes = meetingNotesEntries) {
  const timestamp = new Date().toISOString();
  return notes
    .map((note, index) => ({
      id: typeof note?.id === 'string' && note.id.trim() ? note.id.trim() : `note-${index + 1}`,
      text: typeof note?.text === 'string' ? note.text.trim() : '',
      meetingTimeSeconds: Math.max(0, Math.floor(Number(note?.meetingTimeSeconds) || 0)),
      includeMeetingTime: !!note?.includeMeetingTime,
      createdAt: typeof note?.createdAt === 'string' ? note.createdAt : timestamp,
      updatedAt: timestamp,
    }))
    .filter(note => note.text);
}

function setMeetingNotesStatus(message, tone = 'muted') {
  if (!meetingNotesStatusEl) return;
  meetingNotesStatusEl.textContent = message;
  meetingNotesStatusEl.className = `captura-side-note mb-0 ${STATUS_CLASS[tone] || STATUS_CLASS.muted}`;
}

function clearSelectedPostProcessCacheEntries() {
  const mediaName = selectedMediaEntry?.name || '';
  const transcriptName = transcriptVersionSel.value || '';
  if (!mediaName || !transcriptName) return;

  const prefix = `${mediaName}::${transcriptName}::`;
  Array.from(postProcessResultsByTranscript.keys()).forEach(key => {
    if (key.startsWith(prefix) && !key.endsWith('::notes-off')) postProcessResultsByTranscript.delete(key);
  });
}

function renderMeetingNotesList() {
  if (!meetingNotesListEl) return;

  meetingNotesListEl.replaceChildren();
  const notes = meetingNotesEntries;
  const canEdit = getMeetingNotesCanEdit() && !meetingNotesUiLocked;

  if (!meetingNotesSessionFileName) {
    const empty = document.createElement('div');
    empty.className = 'captura-meeting-notes-empty';
    empty.textContent = 'Inicie a gravação para registrar notas manuais.';
    meetingNotesListEl.append(empty);
    return;
  }

  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'captura-meeting-notes-empty';
    empty.textContent = canEdit
      ? 'Sem notas ainda. Clique em Nova nota para começar.'
      : 'As notas desta reunião aparecem aqui quando houver conteúdo salvo.';
    meetingNotesListEl.append(empty);
    return;
  }

  notes.forEach((note, index) => {
    const article = document.createElement('article');
    article.className = 'captura-meeting-note';
    article.dataset.noteId = note.id;
    article.classList.toggle('is-empty', !note.text.trim());

    const header = document.createElement('div');
    header.className = 'captura-meeting-note-header';

    const title = document.createElement('span');
    title.className = 'captura-meeting-note-label';
    title.textContent = `Nota ${index + 1}`;

    header.append(title);

    if (note.includeMeetingTime) {
      const time = document.createElement('span');
      time.className = 'captura-meeting-note-time';
      time.textContent = formatMeetingTimePrefix(note.meetingTimeSeconds);
      header.append(time);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'captura-icon-button captura-meeting-note-remove';
    removeBtn.innerHTML = '<i class="fas fa-trash-can"></i>';
    removeBtn.title = 'Remover nota';
    removeBtn.disabled = !canEdit;
    removeBtn.addEventListener('click', () => {
      if (!getMeetingNotesCanEdit()) return;
      meetingNotesEntries = meetingNotesEntries.filter(item => item.id !== note.id);
      meetingNotesDirty = true;
      renderMeetingNotesPanel();
      queueMeetingNotesSave({ immediate: true });
    });
    header.append(removeBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'form-control form-control-sm captura-meeting-note-textarea';
    textarea.rows = 3;
    textarea.placeholder = 'Escreva uma nota curta sobre a reunião.';
    textarea.value = note.text;
    textarea.disabled = !canEdit;
    textarea.addEventListener('input', () => {
      const nextValue = textarea.value;
      note.text = nextValue;
      note.updatedAt = new Date().toISOString();
      article.classList.toggle('is-empty', !nextValue.trim());
      meetingNotesDirty = true;
      queueMeetingNotesSave();
    });

    article.append(header, textarea);
    meetingNotesListEl.append(article);
  });
}

function renderMeetingNotesPanel() {
  if (!meetingNotesPanelEl || !meetingNotesAddBtn || !meetingNotesPrefixBtn || !meetingNotesStatusEl || !meetingNotesListEl) {
    return;
  }

  const canEdit = getMeetingNotesCanEdit() && !meetingNotesUiLocked;
  const hasSession = !!meetingNotesSessionFileName;
  const noteCount = meetingNotesEntries.filter(note => note.text.trim()).length;
  const savedLabel = hasSession ? meetingNotesSessionFileName : '';

  meetingNotesAddBtn.disabled = !canEdit;
  meetingNotesPrefixBtn.disabled = !canEdit;
  meetingNotesPrefixBtn.classList.toggle('is-active', meetingNotesPrefixEnabled);
  meetingNotesPrefixBtn.setAttribute('aria-pressed', String(meetingNotesPrefixEnabled));

  if (meetingNotesSaving) {
    setMeetingNotesStatus(`Salvando notas em ${savedLabel}…`, 'warning');
  } else if (!hasSession) {
    setMeetingNotesStatus('Inicie a gravação para registrar notas manuais.', 'muted');
  } else if (noteCount > 0) {
    setMeetingNotesStatus(
      meetingNotesSessionActive
        ? `${noteCount} nota${noteCount === 1 ? '' : 's'} pronta${noteCount === 1 ? '' : 's'} para esta reunião.`
        : `${noteCount} nota${noteCount === 1 ? '' : 's'} salva${noteCount === 1 ? '' : 's'} em ${savedLabel}.`,
      'success'
    );
  } else {
    setMeetingNotesStatus(
      meetingNotesSessionActive
        ? 'Sem notas ainda. Clique em Nova nota para começar.'
        : `Nenhuma nota salva em ${savedLabel}.`,
      'muted'
    );
  }

  renderMeetingNotesList();
}

function syncMeetingNotesPostProcessControl() {
  if (!meetingNotesPostProcessControlEl || !meetingNotesPostProcessChk) return;

  const mediaName = selectedMediaEntry?.name || '';
  const hasNotes = !!mediaName && !selectedMediaNotesLoading && hasMeetingNotes(selectedMediaNotesInfo);
  const checked = hasNotes ? getMeetingNotesPostProcessEnabled(mediaName) : false;

  meetingNotesPostProcessControlEl.hidden = !mediaName;
  meetingNotesPostProcessControlEl.classList.toggle('is-disabled', !hasNotes || meetingNotesPostProcessLocked);
  meetingNotesPostProcessChk.checked = checked;
  meetingNotesPostProcessChk.disabled = meetingNotesPostProcessLocked || selectedMediaNotesLoading || !hasNotes;

  if (meetingNotesPostProcessHintEl) {
    meetingNotesPostProcessHintEl.hidden = !mediaName;
    meetingNotesPostProcessHintEl.textContent = !mediaName
      ? 'Selecione um arquivo para decidir se as notas entram no pós-processamento.'
      : selectedMediaNotesLoading
        ? 'Carregando notas deste arquivo...'
        : hasNotes
          ? (checked
            ? 'As notas deste arquivo entram no pós-processamento desta sessão.'
            : 'As notas ficam separadas do pós-processamento desta sessão.')
          : 'Sem notas salvas para este arquivo.';
  }
}

function startMeetingNotesSession(fileName) {
  clearTimeout(meetingNotesSaveTimerId);
  meetingNotesSaveTimerId = null;
  meetingNotesQueuedSave = false;
  meetingNotesSaving = false;
  meetingNotesDirty = false;
  meetingNotesSessionFileName = fileName || '';
  meetingNotesSessionActive = !!fileName;
  meetingNotesEntries = [];
  meetingNotesUiLocked = false;
  renderMeetingNotesPanel();
}

function finishMeetingNotesSession() {
  clearTimeout(meetingNotesSaveTimerId);
  meetingNotesSaveTimerId = null;
  meetingNotesQueuedSave = false;
  meetingNotesSaving = false;
  meetingNotesDirty = false;
  meetingNotesSessionActive = false;
  meetingNotesUiLocked = true;
  meetingNotesEntries = meetingNotesEntries.filter(note => note.text.trim());
  renderMeetingNotesPanel();
}

function queueMeetingNotesSave({ immediate = false } = {}) {
  if (!meetingNotesSessionFileName) return Promise.resolve(null);

  meetingNotesDirty = true;
  clearTimeout(meetingNotesSaveTimerId);
  meetingNotesSaveTimerId = null;

  if (immediate) {
    meetingNotesSavePromise = saveMeetingNotesToDisk();
    return meetingNotesSavePromise;
  }

  meetingNotesSaveTimerId = setTimeout(() => {
    meetingNotesSavePromise = saveMeetingNotesToDisk();
    void meetingNotesSavePromise;
  }, 300);

  return Promise.resolve(null);
}

async function flushMeetingNotesSave() {
  clearTimeout(meetingNotesSaveTimerId);
  meetingNotesSaveTimerId = null;

  if (!meetingNotesSessionFileName) return null;
  if (meetingNotesSaving) return meetingNotesSavePromise;

  meetingNotesSavePromise = saveMeetingNotesToDisk();
  return meetingNotesSavePromise;
}

async function saveMeetingNotesToDisk() {
  if (!meetingNotesSessionFileName) return null;
  if (meetingNotesSaving) {
    meetingNotesQueuedSave = true;
    return meetingNotesSavePromise;
  }

  meetingNotesSaving = true;
  setMeetingNotesStatus(`Salvando notas em ${meetingNotesSessionFileName}…`, 'warning');

  const notesToPersist = normalizeMeetingNotesEntries();
  const targetFileName = meetingNotesSessionFileName;
  let nextStatus = null;

  try {
    const dirOk = await storage.ensureAccess({
      mode: 'readwrite',
      silent: true,
      requestIfNeeded: false,
    });
    if (!dirOk) {
      meetingNotesDirty = true;
      nextStatus = { message: 'Não foi possível salvar as notas agora.', tone: 'warning' };
      return null;
    }

    let result = null;
    if (!notesToPersist.length) {
      result = await mediaLibrary.deleteMeetingNotes(meetingNotesSessionFileName);
    } else {
      result = await mediaLibrary.writeMeetingNotes(meetingNotesSessionFileName, notesToPersist);
    }
    meetingNotesDirty = false;
    nextStatus = {
      message: notesToPersist.length
        ? `${notesToPersist.length} nota${notesToPersist.length === 1 ? '' : 's'} salva${notesToPersist.length === 1 ? '' : 's'} em ${targetFileName}.`
        : meetingNotesSessionActive
          ? 'Sem notas ainda. Clique em Nova nota para começar.'
          : `Nenhuma nota salva em ${targetFileName}.`,
      tone: notesToPersist.length ? 'success' : 'muted',
    };

    if (selectedMediaEntry?.name === meetingNotesSessionFileName) {
      selectedMediaNotesInfo = await mediaLibrary.getMediaNotesInfo(meetingNotesSessionFileName);
      clearSelectedPostProcessCacheEntries();
      renderSelectedTranscriptViewer();
      syncPostProcessOutput();
    }

    const libraryEntry = libraryEntries.find(item => item.name === meetingNotesSessionFileName);
    if (libraryEntry) {
      libraryEntry.notesCount = notesToPersist.length;
      libraryEntry.notesFileName = notesToPersist.length ? result?.fileName || '' : '';
    }
    renderMediaFileList();

    return result;
  } catch (error) {
    meetingNotesDirty = true;
    nextStatus = { message: error.message || 'Falha ao salvar notas.', tone: 'danger' };
    return null;
  } finally {
    meetingNotesSaving = false;
    if (meetingNotesQueuedSave) {
      meetingNotesQueuedSave = false;
      meetingNotesSavePromise = saveMeetingNotesToDisk();
      return meetingNotesSavePromise;
    }
    if (nextStatus) setMeetingNotesStatus(nextStatus.message, nextStatus.tone);
  }
}

function addMeetingNote() {
  if (!getMeetingNotesCanEdit()) return;

  meetingNotesEntries = [...meetingNotesEntries, createMeetingNoteEntry({
    meetingTimeSeconds: elapsedSecs,
    includeMeetingTime: meetingNotesPrefixEnabled,
  })];
  meetingNotesDirty = true;
  renderMeetingNotesPanel();
  queueMeetingNotesSave();
  const lastNoteField = meetingNotesListEl?.querySelector('[data-note-id]:last-child textarea');
  lastNoteField?.focus();
}

function applyPostProcessPreset(presetKey) {
  if (!presetKey || !POSTPROCESS_PROMPT_PRESETS[presetKey]) return;
  postProcessPromptEl.value = POSTPROCESS_PROMPT_PRESETS[presetKey];
  savePref(PREFS.postProcessPrompt, postProcessPromptEl.value);
}

function buildMediaListItem(entry) {
  const article = document.createElement('article');
  article.className = 'captura-library-entry';

  const item = document.createElement('div');
  item.className = 'captura-library-item';
  item.dataset.name = entry.name;
  item.setAttribute('role', 'button');
  item.tabIndex = 0;

  const shell = document.createElement('div');
  shell.className = 'captura-library-item-shell';

  const iconBox = document.createElement('div');
  iconBox.className = 'captura-library-thumb';
  if (entry.kind === 'video') {
    iconBox.classList.add('is-video');
    iconBox.innerHTML = '<i class="fas fa-circle-play"></i>';
    loadVideoThumbnailInto(iconBox, entry);
  } else {
    iconBox.classList.add('is-audio');
    iconBox.innerHTML = '<i class="fas fa-wave-square"></i>';
  }

  const body = document.createElement('div');
  body.className = 'captura-library-copy';

  const top = document.createElement('div');
  top.className = 'd-flex align-items-start justify-content-between gap-2';

  const name = document.createElement('span');
  name.className = 'captura-library-name';
  name.textContent = entry.name;

  const badge = document.createElement('span');
  badge.className = 'captura-library-kind';
  badge.textContent = entry.kind === 'video' ? 'VÍDEO' : 'ÁUDIO';

  top.append(name, badge);

  const bottom = document.createElement('div');
  bottom.className = 'captura-library-meta';

  const metaRow = document.createElement('div');
  metaRow.className = 'captura-library-meta-row';

  const dateLabel = document.createElement('span');
  dateLabel.textContent = entry.lastModified
    ? LIBRARY_DATE_FORMATTER.format(entry.lastModified)
    : 'Sem data';

  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = fmtBytes(entry.size);

  const transcriptLabel = document.createElement('small');
  transcriptLabel.className = 'captura-library-transcripts';
  transcriptLabel.textContent = entry.transcriptCount
    ? `${entry.transcriptCount} transcri${entry.transcriptCount === 1 ? 'ção' : 'ções'}`
    : 'Sem transcrição';

  const notesLabel = document.createElement('small');
  notesLabel.className = 'captura-library-transcripts captura-library-notes';
  notesLabel.textContent = entry.notesCount
    ? `${entry.notesCount} nota${entry.notesCount === 1 ? '' : 's'}`
    : 'Sem notas';

  metaRow.append(
    dateLabel,
    document.createTextNode(' • '),
    sizeLabel,
    document.createTextNode(' • '),
    transcriptLabel,
    document.createTextNode(' • '),
    notesLabel
  );

  const detailRow = document.createElement('div');
  detailRow.className = 'captura-library-meta-row captura-library-meta-row-secondary';

  const eventLabel = document.createElement('small');
  eventLabel.className = 'captura-library-event';
  eventLabel.tabIndex = 0;
  eventLabel.dataset.mediaName = entry.name;
  eventLabel.dataset.originalValue = entry.eventDescription || '';
  renderMediaEventField(eventLabel, entry);
  eventLabel.addEventListener('click', event => {
    event.stopPropagation();
    if (!eventLabel.classList.contains('is-editing')) {
      beginMediaEventEdit(eventLabel, entry);
    }
  });
  eventLabel.addEventListener('keydown', event => {
    if (eventLabel.classList.contains('is-editing')) {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        void saveMediaEventEdit(eventLabel, entry);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renderMediaEventField(eventLabel, entry);
      }
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      beginMediaEventEdit(eventLabel, entry);
    }
  });
  eventLabel.addEventListener('blur', () => {
    if (eventLabel.classList.contains('is-editing')) {
      void saveMediaEventEdit(eventLabel, entry);
    }
  });
  item.addEventListener('click', () => {
    if (item.classList.contains('is-disabled')) return;
    void selectMediaEntryByName(entry.name);
  });
  item.addEventListener('keydown', event => {
    if (item.classList.contains('is-disabled')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void selectMediaEntryByName(entry.name);
    }
  });

  const chevron = document.createElement('span');
  chevron.className = 'captura-library-chevron';
  chevron.innerHTML = `<i class="fas fa-chevron-${selectedMediaEntry?.name === entry.name ? 'up' : 'down'}"></i>`;

  detailRow.append(eventLabel);
  bottom.append(metaRow, detailRow);
  body.append(top, bottom);
  shell.append(iconBox, body);
  item.append(shell, chevron);
  article.append(item);
  return { article, item };
}

function renderMediaFileList() {
  const scrollTop = mediaFileListEl.scrollTop;
  const activeEntryName = selectedMediaEntry?.name;

  mediaFileListEl.replaceChildren();

  if (!libraryEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'captura-library-empty';
    empty.textContent = storage.dirHandle
      ? 'Nenhum arquivo de áudio ou vídeo compatível foi encontrado na pasta selecionada.'
      : 'Escolha uma pasta para listar os arquivos de áudio e vídeo.';
    mediaFileListEl.appendChild(empty);
    return;
  }

  libraryEntries.forEach(entry => {
    const { article, item } = buildMediaListItem(entry);
    const isDisabled = postProcessingBusy;
    item.classList.toggle('is-disabled', isDisabled);
    item.setAttribute('aria-disabled', String(isDisabled));
    item.tabIndex = isDisabled ? -1 : 0;
    if (selectedMediaEntry?.name === entry.name) item.classList.add('active');
    if (selectedMediaEntry?.name === entry.name) {
      article.classList.add('is-active');
      mediaDetailPanelEl.hidden = false;
      article.appendChild(mediaDetailPanelEl);
    }
    mediaFileListEl.appendChild(article);
  });

  if (!selectedMediaEntry) hideMediaDetailPanel();
  syncMeetingNotesPostProcessControl();

  if (activeEntryName) {
    const activeEl = mediaFileListEl.querySelector(`[data-name="${activeEntryName}"]`)?.closest('article');
    if (activeEl) activeEl.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }
}

function updateLibrarySummary() {
  if (!storage.dirHandle) {
    librarySummaryEl.textContent = 'Selecione uma pasta para listar áudios e vídeos.';
    return;
  }

  if (!libraryEntries.length) {
    librarySummaryEl.textContent = `Nenhum arquivo compatível foi encontrado em ${storage.dirHandle.name}.`;
    return;
  }

  librarySummaryEl.textContent = `${libraryEntries.length} arquivo${libraryEntries.length === 1 ? '' : 's'} encontrado${libraryEntries.length === 1 ? '' : 's'} em ${storage.dirHandle.name}.`;
}

function handleTranscriptionError(error, {
  toast = true,
  dialog = false,
  updateTranscriptPane = false,
  updateLivePane = true,
} = {}) {
  const title = error?.title || 'Erro de transcrição';
  const message = error?.message || String(error ?? 'Erro de transcrição desconhecido.');

  if (updateLivePane) setTranscriptionStatus(message, 'danger');
  if (updateTranscriptPane) setSelectedTranscriptStatus(message, 'danger');

  if (toast) showToast(message, 'danger');
  if (dialog) showErrorDialog(title, message, error);
  if (error instanceof OpenAIConfigError) openOpenAiPanel();
  if (error instanceof AssemblyAIConfigError) openAssemblyAiPanel();
  if (error instanceof DeepSeekConfigError) openDeepSeekPanel();
}

async function loadMediaPreview(mediaEntry) {
  resetMediaPreview();
  if (!mediaEntry) return;

  const file = await mediaEntry.handle.getFile();
  selectedPreviewUrl = URL.createObjectURL(file);

  const target = isVideoFileName(mediaEntry.name) ? selectedVideoPlayerEl : selectedAudioPlayerEl;
  target.src = selectedPreviewUrl;
  target.hidden = false;
  mediaPreviewPlaceholderEl.hidden = true;
}

async function loadSelectedMediaNotes(mediaFileName) {
  try {
    selectedMediaNotesInfo = await mediaLibrary.getMediaNotesInfo(mediaFileName);
  } catch (_) {
    selectedMediaNotesInfo = null;
  }
}

function renderSelectedTranscriptViewer() {
  if (transcriptEditingEnabled) {
    transcriptViewerEl.value = selectedTranscriptRawText;
    transcriptViewerEl.placeholder = 'Edite a transcrição. Cada alteração será salva no arquivo selecionado.';
    return;
  }

  const combinedText = buildTranscriptViewerText(selectedTranscriptRawText, selectedMediaNotesInfo);
  if (!combinedText) {
    clearTranscriptViewer('Este arquivo ainda não possui uma transcrição salva.');
    updateTranscriptEditUi();
    return;
  }

  transcriptViewerEl.value = combinedText;
  transcriptViewerEl.placeholder = 'A transcrição selecionada será exibida aqui.';
  updateTranscriptEditUi();
}

async function loadTranscriptEntries(mediaFileName, preferredTranscriptName = '') {
  selectedTranscriptEntries = await mediaLibrary.getRelatedTranscripts(mediaFileName);
  transcriptVersionSel.replaceChildren();

  if (!selectedTranscriptEntries.length) {
    transcriptVersionSel.add(new Option('Nenhuma transcrição ainda', ''));
    transcriptVersionSel.disabled = true;
    selectedTranscriptRawText = '';
    renderSelectedTranscriptViewer();
    setSelectedTranscriptStatus(
      hasMeetingNotes(selectedMediaNotesInfo)
        ? 'Ainda não existe transcrição salva para este arquivo. As notas da reunião já estão disponíveis abaixo.'
        : 'Ainda não existe transcrição salva para este arquivo.',
      'muted'
    );
    syncPostProcessOutput();
    return;
  }

  selectedTranscriptEntries.forEach(entry => {
    transcriptVersionSel.add(new Option(entry.name, entry.name));
  });
  transcriptVersionSel.disabled = false;

  const cachedTranscriptName = selectedTranscriptNameByMedia.get(mediaFileName);
  const preferred = selectedTranscriptEntries.find(entry => entry.name === preferredTranscriptName);
  const cached = selectedTranscriptEntries.find(entry => entry.name === cachedTranscriptName);
  transcriptVersionSel.value = preferred?.name || cached?.name || selectedTranscriptEntries[0].name;
  await loadSelectedTranscript();
}

async function loadSelectedTranscript() {
  stopTranscriptEditing({ renderViewer: false });
  const transcriptEntry = getSelectedTranscriptEntry();

  if (!transcriptEntry) {
    selectedTranscriptRawText = '';
    renderSelectedTranscriptViewer();
    setSelectedTranscriptStatus(
      hasMeetingNotes(selectedMediaNotesInfo)
        ? 'Ainda não existe transcrição salva para este arquivo. As notas da reunião já estão disponíveis abaixo.'
        : 'Ainda não existe transcrição salva para este arquivo.',
      'muted'
    );
    syncPostProcessOutput();
    return;
  }

  const transcriptText = await mediaLibrary.readTranscript(transcriptEntry.handle);
  selectedTranscriptRawText = transcriptText;
  renderSelectedTranscriptViewer();
  if (selectedMediaEntry?.name) {
    selectedTranscriptNameByMedia.set(selectedMediaEntry.name, transcriptEntry.name);
  }
  setSelectedTranscriptStatus(
    hasMeetingNotes(selectedMediaNotesInfo)
      ? `Exibindo ${transcriptEntry.name} com notas da reunião.`
      : `Exibindo ${transcriptEntry.name}.`,
    'success'
  );
  syncPostProcessOutput();
}

async function selectMediaEntryByName(mediaName, preferredTranscriptName = '') {
  stopTranscriptEditing({ renderViewer: false });
  const entry = libraryEntries.find(item => item.name === mediaName);
  if (!entry) return;

  selectedMediaEntry = entry;
  selectedMediaNotesInfo = null;
  selectedMediaNotesLoading = true;
  renderMediaFileList();

  try {
    await loadMediaPreview(entry);
    await loadSelectedMediaNotes(entry.name);
    selectedMediaNotesLoading = false;
    syncMeetingNotesPostProcessControl();
    await loadTranscriptEntries(entry.name, preferredTranscriptName);
  } catch (error) {
    selectedTranscriptEntries = [];
    selectedTranscriptRawText = '';
    selectedMediaNotesInfo = null;
    selectedMediaNotesLoading = false;
    clearTranscriptViewer();
    setSelectedTranscriptStatus('Não foi possível carregar o arquivo selecionado.', 'danger');
    setPostProcessStatus('Não foi possível carregar a transcrição selecionada.', 'danger');
    handleTranscriptionError(error, { toast: true, dialog: false, updateLivePane: false });
  }

  render(machine.state);
}

async function refreshMediaLibrary({
  preferredMediaName = selectedMediaEntry?.name || '',
  preferredTranscriptName = '',
  silent = false,
} = {}) {
  if (!authUnlocked) return;
  if (!storage.dirHandle) {
    libraryEntries = [];
    clearSelectedMediaState();
    renderMediaFileList();
    updateLibrarySummary();
    render(machine.state);
    return;
  }

  const dirOk = await storage.ensureAccess({
    mode: 'readwrite',
    silent,
    requestIfNeeded: !silent,
  });
  if (!dirOk) return;

  libraryEntries = await mediaLibrary.listMediaFiles();
  updateLibrarySummary();
  renderMediaFileList();

  if (!libraryEntries.length) {
    clearSelectedMediaState('Nenhum arquivo de áudio ou vídeo compatível foi encontrado na pasta selecionada.');
    render(machine.state);
    return;
  }

  const nextMediaName = libraryEntries.some(entry => entry.name === preferredMediaName)
    ? preferredMediaName
    : libraryEntries[0].name;
  await selectMediaEntryByName(nextMediaName, preferredTranscriptName);
}

async function transcribeSelectedMedia({ alwaysVersion = false } = {}) {
  if (!selectedMediaEntry) return;
  const mediaName = selectedMediaEntry.name;
  const mediaHandle = selectedMediaEntry.handle;
  const engineValue = getSelectedTranscriptionEngine();
  const baseEngine = getBaseEngine(engineValue);
  const engineLabel = getSelectedEngineDisplayLabel(engineValue);
  const speechModels = baseEngine === TRANSCRIPTION_ENGINES.assemblyai ? getAssemblyAiSpeechModels(engineValue) : null;
  const speechModelsLabel = speechModels ? speechModels.join(',') : '';
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

  trackEvent('captura_transcription_start', {
    file_name: mediaName,
    force_new_version: alwaysVersion,
    engine: baseEngine,
    speech_models: speechModelsLabel,
    mode,
  });
  transcriptionBusy = true;
  renderMediaFileList();
  render(machine.state);
  setSelectedTranscriptStatus(`Preparando ${mediaName} para transcrição em ${modeLabel} com ${engineLabel}…`, 'muted');
  setTranscriptionStatus(
    `Preparando ${mediaName} para transcrição em ${modeLabel} com ${engineLabel}. Arquivos longos podem levar vários minutos; mantenha esta aba aberta.`,
    'muted',
    { active: true }
  );

  try {
    const result = await transcriptionController.transcribeFileHandle(mediaHandle, {
      prompt: getFileTranscriptionPrompt(),
      alwaysVersion,
      engine: baseEngine,
      speechModels,
      mode,
      onProgress: payload => {
        reportTranscriptionProgress(payload, { includeSelected: true });
      },
    });

    showToast(`Transcrição salva como ${result.fileName}.`, 'success');
    setSelectedTranscriptStatus(`Transcrição salva como ${result.fileName}.`, 'success');
    setTranscriptionStatus(`Transcrição salva como ${result.fileName}.`, 'success');
    trackEvent('captura_transcription_saved', {
      file_name: mediaName,
      engine: baseEngine,
      speech_models: speechModelsLabel,
      transcript_name: result.fileName,
      mode,
    });
    await refreshMediaLibrary({
      preferredMediaName: mediaName,
      preferredTranscriptName: result.fileName,
      silent: true,
    });
  } catch (error) {
    trackEvent('captura_transcription_error', { file_name: mediaName, engine: baseEngine, speech_models: speechModelsLabel });
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

async function processSelectedTranscript() {
  const transcriptText = buildTranscriptProcessingText();
  if (!selectedMediaEntry || !transcriptVersionSel.value || !transcriptText.trim()) return;

  const postProcessModel = getSelectedPostProcessModel();
  const postProcessClient = getPostProcessClient(postProcessModel);

  try {
    postProcessClient.assertConfigured();
  } catch (error) {
    setPostProcessStatus(error.message, 'danger');
    handleTranscriptionError(error, {
      toast: false,
      dialog: true,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
    return;
  }

  const transcriptName = transcriptVersionSel.value;
  const cacheKey = getSelectedTranscriptCacheKey();
  const notesIncluded = getMeetingNotesPostProcessEnabled(selectedMediaEntry.name) && hasMeetingNotes();
  const notesSuffix = notesIncluded ? ' com notas da reunião' : '';

  postProcessingBusy = true;
  renderMediaFileList();
  render(machine.state);
  setPostProcessStatus(`Processando ${transcriptName}${notesSuffix} com ${postProcessModel}…`, 'muted');
  setTranscriptionStatus(`Processando ${transcriptName}${notesSuffix} com ${postProcessModel}. Aguarde e mantenha esta aba aberta…`, 'muted', { active: true });
  trackEvent('captura_postprocess_start', {
    file_name: selectedMediaEntry.name,
    model: postProcessModel,
    transcript_name: transcriptName,
    notes_included: notesIncluded,
  });

  try {
    const result = await postProcessText({
      text: transcriptText,
      prompt: postProcessPromptEl.value,
      model: postProcessModel,
    });

    if (cacheKey) postProcessResultsByTranscript.set(cacheKey, result);
    postProcessOutputEl.value = result;
    updatePostProcessActionButtons();
    setPostProcessStatus('Texto reformulado com sucesso.', 'success');
    setTranscriptionStatus(`Pós-processamento concluído para ${transcriptName}.`, 'success');
    trackEvent('captura_postprocess_saved', {
      file_name: selectedMediaEntry.name,
      model: postProcessModel,
      transcript_name: transcriptName,
    });
  } catch (error) {
    setPostProcessStatus(error.message || 'Falha no pós-processamento.', 'danger');
    trackEvent('captura_postprocess_error', {
      file_name: selectedMediaEntry.name,
      model: postProcessModel,
      transcript_name: transcriptName,
    });
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
  } finally {
    postProcessingBusy = false;
    renderMediaFileList();
    render(machine.state);
  }
}

async function startLiveTranscriptionForRecording() {
  if (!isLiveTranscriptionEnabled()) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
    return;
  }

  const engineValue = getSelectedTranscriptionEngine();
  const baseEngine = getBaseEngine(engineValue);
  const engineLabel = getSelectedEngineDisplayLabel(engineValue);
  const speechModels = baseEngine === TRANSCRIPTION_ENGINES.assemblyai ? getAssemblyAiSpeechModels(engineValue) : null;
  const speechModelsLabel = speechModels ? speechModels.join(',') : '';

  try {
    getTranscriptionClient(baseEngine).assertConfigured();
  } catch (error) {
    setLiveTranscriptBadge('Chave necessária', 'badge bg-danger');
    handleTranscriptionError(error, {
      toast: false,
      dialog: true,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
    return;
  }

  const track = audioMixer.getMixedTrackClone();
  if (!track) {
    setLiveTranscriptBadge('Sem áudio', 'badge bg-secondary');
    setTranscriptionStatus('A transcrição ao vivo foi ignorada porque esta gravação não tem fonte de áudio ativa.', 'warning');
    return;
  }

  liveTranscriptOutputEl.value = '';
  setLiveTranscriptBadge('Iniciando', 'badge bg-info');
  setTranscriptionStatus(`Iniciando transcrição ao vivo com ${engineLabel}…`, 'muted');

  try {
    await transcriptionController.startLiveTranscription({
      track,
      prompt: getLiveTranscriptionPrompt(),
      engine: baseEngine,
      speechModels,
      mediaFileName: api.activeFileHandle?.name || '',
    });
    setLiveTranscriptBadge('Ouvindo', 'badge bg-success');
    trackEvent('captura_live_transcription_start', { engine: baseEngine, speech_models: speechModelsLabel });
  } catch (error) {
    track.stop();
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
  }
}

async function stopLiveTranscription({ preserveBadge = false } = {}) {
  pendingLiveStopPromise = transcriptionController.stopLiveTranscription().catch(error => {
    handleTranscriptionError(error, { toast: false, dialog: false, updateTranscriptPane: false, updateLivePane: true });
    return transcriptionController.liveTranscript;
  });

  const liveText = await pendingLiveStopPromise;
  if (liveText) liveTranscriptOutputEl.value = liveText;
  if (!preserveBadge && !recordingTranscriptInFlight) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
  }
  return liveText;
}

async function finalizeSavedRecordingTranscript(fileHandle) {
  if (!fileHandle) {
    finishMeetingNotesSession();
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
    return;
  }

  try {
    await flushMeetingNotesSave();
  } catch (error) {
    console.warn('Falha ao salvar notas da reunião antes do pós-processamento:', error);
  }

  if (!isLiveTranscriptionEnabled()) {
    await refreshMediaLibrary({
      preferredMediaName: fileHandle.name,
      silent: true,
    }).catch(() => {});
    finishMeetingNotesSession();
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
    return;
  }

  transcriptionBusy = true;
  recordingTranscriptInFlight = true;
  const engine = getSelectedTranscriptionEngine();
  const engineLabel = getSelectedEngineLabel(engine);
  const requestedMode = getTranscriptionMode();
  const mode = isTranscriptionModeSupported(requestedMode, getTranscriptionClient(engine))
    ? requestedMode
    : TRANSCRIPTION_OUTPUT_MODES.plain;
  const modeLabel = TRANSCRIPTION_OUTPUT_MODE_LABELS[mode] || TRANSCRIPTION_OUTPUT_MODE_LABELS.plain;
  renderMediaFileList();
  render(machine.state);
  setLiveTranscriptBadge('Finalizando', 'badge bg-info');
  setTranscriptionStatus(
    `Preparando a gravação salva para transcrição em ${modeLabel} com ${engineLabel}. Isso pode levar vários minutos; mantenha esta aba aberta.`,
    'muted',
    { active: true }
  );

  let preferredTranscriptName = '';

  try {
    const liveText = await pendingLiveStopPromise;
    if (liveText.trim()) {
      const liveResult = await mediaLibrary.writeTranscriptIncremental(fileHandle.name, liveText, { variant: 'live' });
      preferredTranscriptName = liveResult.fileName;
      setTranscriptionStatus(`Transcrição ao vivo salva como ${liveResult.fileName}.`, 'success');
      trackEvent('captura_live_transcript_saved', { engine, transcript_name: liveResult.fileName });
    }

    const result = await transcriptionController.transcribeFileHandle(fileHandle, {
      prompt: getFileTranscriptionPrompt(),
      engine,
      mode,
      onProgress: payload => {
        reportTranscriptionProgress(payload);
      },
    });

    preferredTranscriptName = result.fileName;
    showToast(`Transcrição salva como ${result.fileName}.`, 'success');
    setTranscriptionStatus(`Transcrição salva como ${result.fileName}.`, 'success');
    setLiveTranscriptBadge('Salvo', 'badge bg-success');
    trackEvent('captura_recording_transcript_saved', { engine, transcript_name: result.fileName, mode });

    await refreshMediaLibrary({
      preferredMediaName: fileHandle.name,
      preferredTranscriptName,
      silent: true,
    });
  } catch (error) {
    if (preferredTranscriptName) {
      await refreshMediaLibrary({
        preferredMediaName: fileHandle.name,
        preferredTranscriptName,
        silent: true,
      }).catch(() => {});
    }
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
  } finally {
    transcriptionBusy = false;
    recordingTranscriptInFlight = false;
    finishMeetingNotesSession();
    renderMediaFileList();
    render(machine.state);
  }
}

// ── UI rendering ───────────────────────────────────────────────────────────────

function render(state) {
  const isSession   = state === STATE.SESSION;
  const isReq       = state === STATE.REQUESTING;
  const isRec       = state === STATE.RECORDING;
  const isPaused    = state === STATE.PAUSED;
  const isStopping  = state === STATE.STOPPING;
  const isError     = state === STATE.ERROR;
  const active      = isRec || isPaused;
  const hasSession  = isSession || api.hasSession;
  const selectedTranscriptionClient = getTranscriptionClient();
  const promptSupported = selectedTranscriptionClient?.supportsPrompt !== false;

  startBtn.hidden   = active || isStopping;
  startBtn.disabled = isReq;

  pauseBtn.hidden    = !active;
  pauseBtn.disabled  = false;
  pauseBtn.innerHTML = isPaused
    ? '<i class="fas fa-play me-1"></i>Retomar'
    : '<i class="fas fa-pause me-1"></i>Pausar';
  pauseBtn.className = isPaused
    ? 'btn captura-pause-button is-resume'
    : 'btn captura-pause-button';

  stopBtn.hidden   = !active;
  stopBtn.disabled = false;

  micToggleBtn.hidden   = !active || !api.hasActiveMic;
  micToggleBtn.disabled = !active || !api.hasActiveMic;
  micToggleBtn.innerHTML = api.isMicMuted
    ? '<i class="fas fa-microphone me-1"></i>Ativar microfone'
    : '<i class="fas fa-microphone-slash me-1"></i>Silenciar microfone';
  micToggleBtn.className = api.isMicMuted ? 'btn btn-success' : 'btn btn-danger';

  endSessionBtn.hidden   = !hasSession;
  endSessionBtn.disabled = isStopping || isReq;

  const lockControls = active || isStopping || isReq || transcriptionBusy || postProcessingBusy;
  const mp3Mode = isMp3Format(formatSel.value);
  const hasSelectedTranscript = selectedTranscriptEntries.length > 0 && !!transcriptVersionSel.value;
  const notesCanEdit = !!meetingNotesSessionFileName && (isRec || isPaused) && !isStopping && !isReq && !transcriptionBusy && !postProcessingBusy;
  meetingNotesUiLocked = !notesCanEdit;
  meetingNotesPostProcessLocked = lockControls;

  pickDirBtn.disabled     = lockControls;
  webcamSel.disabled      = lockControls || mp3Mode;
  micSel.disabled         = lockControls;
  sysAudioChk.disabled    = lockControls || !hasGetDisplayMedia;
  fpsSel.disabled         = lockControls || mp3Mode;
  qualitySel.disabled     = lockControls || mp3Mode;
  formatSel.disabled      = lockControls;
  liveTranscriptionChk.disabled = lockControls;
  transcriptionPromptEl.disabled = lockControls || !promptSupported;
  transcriptionModeSel.disabled = lockControls;
  openAiApiKeyInput.disabled = lockControls;
  openAiApiKeyToggleBtn.disabled = lockControls;
  assemblyAiApiKeyInput.disabled = lockControls;
  assemblyAiApiKeyToggleBtn.disabled = lockControls;
  deepSeekApiKeyInput.disabled = lockControls;
  deepSeekApiKeyToggleBtn.disabled = lockControls;
  refreshLibraryBtn.disabled = lockControls || !storage.dirHandle;
  transcribeSelectedBtn.disabled = lockControls || !selectedMediaEntry;
  transcribeNewVersionBtn.disabled = lockControls || !selectedMediaEntry;
  transcriptVersionSel.disabled = lockControls || selectedTranscriptEntries.length === 0;
  processSelectedTranscriptBtn.disabled = lockControls || !hasSelectedTranscript;
  postProcessPromptEl.disabled = lockControls;
  postProcessPresetSel.disabled = lockControls;
  transcriptionEngineInputs.forEach(input => { input.disabled = lockControls; });
  postProcessModelInputs.forEach(input => { input.disabled = lockControls; });
  updateTranscriptEditUi({ lockControls });
  if (meetingNotesAddBtn) meetingNotesAddBtn.disabled = !notesCanEdit;
  updatePostProcessActionButtons({ lockControls });
  renderMeetingNotesPanel();
  syncMeetingNotesPostProcessControl();

  statusBadge.textContent =
      isRec      ? '⏺ Gravando'
    : isPaused   ? '⏸ Pausado'
    : isReq      ? '⏳ Preparando…'
    : isStopping ? '⏳ Salvando…'
    : isSession  ? '◉ Sessão ativa'
    : isError    ? '⚠ Erro'
    :              'Inativo';

  statusBadge.className =
      isRec                    ? 'badge bg-danger'
    : isPaused                 ? 'badge bg-secondary'
    : isReq || isStopping || isSession
      ? 'badge bg-info'
    : isError                  ? 'badge bg-danger'
    :                            'badge bg-secondary';
}

// ── State-change handler ───────────────────────────────────────────────────────

machine.onStateChange((state, event, payload) => {
  render(state);

  if (state === STATE.RECORDING) {
    if (event === EVENT.ENCODER_READY) {
      startMeetingNotesSession(api.activeFileHandle?.name || '');
      trackEvent('captura_recording_start', {
        fps:         payload?.fps,
        quality:     payload?.quality,
        format:      payload?.format,
        has_webcam:  payload?.webcamSelected,
        has_mic:     payload?.micSelected,
        sys_audio:   payload?.wantSysAudio,
      });
      void startLiveTranscriptionForRecording();
    } else if (event === EVENT.USER_RESUME) {
      trackEvent('captura_recording_resume', { elapsed_secs: elapsedSecs });
      transcriptionController.resumeLiveTranscription();
      if (isLiveTranscriptionEnabled()) {
        setLiveTranscriptBadge('Ouvindo', 'badge bg-success');
        setTranscriptionStatus('Transcrição ao vivo retomada.', 'muted');
      }
    }
  } else if (state === STATE.PAUSED) {
    trackEvent('captura_recording_pause', { elapsed_secs: elapsedSecs });
    transcriptionController.pauseLiveTranscription();
    if (isLiveTranscriptionEnabled()) setLiveTranscriptBadge('Pausado', 'badge bg-secondary');
  } else if (state === STATE.STOPPING) {
    trackEvent('captura_recording_stop', { elapsed_secs: elapsedSecs, format: formatSel.value });
    void stopLiveTranscription({ preserveBadge: true }).then(() => {
      if (isLiveTranscriptionEnabled()) setLiveTranscriptBadge('Finalizando', 'badge bg-info');
    });
  } else if (state === STATE.IDLE && event === EVENT.END_SESSION) {
    trackEvent('captura_session_end');
  }

  if (event === EVENT.STREAMS_FAILED) {
    trackEvent('captura_stream_failed', { error_name: payload?.name ?? 'unknown' });
  } else if (state === STATE.ERROR) {
    trackEvent('captura_error', { error_message: payload?.message ?? String(payload ?? '') });
    void stopLiveTranscription();
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
  }

  if (event === EVENT.FINALIZE_DONE && payload) {
    trackEvent('captura_recording_saved', { format: formatSel.value });
    void showSaveSuccessToast(payload);
    void finalizeSavedRecordingTranscript(payload);
  }

  if (state === STATE.RECORDING) {
    if (event === EVENT.USER_RESUME) resumeTimer();
    else startTimer();
  } else if (state === STATE.PAUSED) {
    pauseTimer();
  } else {
    resetTimer();
  }

  if (state === STATE.RECORDING) {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
    setupMediaSession(
      () => machine.transition(EVENT.USER_RESUME, { fps: parseInt(fpsSel.value, 10) }),
      () => machine.transition(EVENT.USER_PAUSE),
      () => machine.transition(EVENT.USER_STOP),
    );
  } else if (state === STATE.PAUSED) {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
  } else {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
    clearMediaSession();
  }

  if (state === STATE.ERROR) {
    showErrorDialog(
      payload?.title   || 'Erro de gravação',
      payload?.message || String(payload ?? 'Ocorreu um erro desconhecido.'),
      payload
    );
  }

  if ((state === STATE.IDLE || state === STATE.SESSION) && !recordingTranscriptInFlight && !isLiveTranscriptionEnabled()) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
  }

  refreshAdvisoryUi();

  if (state === STATE.IDLE || state === STATE.SESSION) {
    syncDevicesToApi();
  }
});

// ── Recorder helpers ───────────────────────────────────────────────────────────

function syncDevicesToApi() {
  const mp3Mode = isMp3Format(formatSel.value);
  api.setDevices({
    webcamDeviceId: webcamSel.value,
    webcamSelected: !mp3Mode && webcamSel.selectedIndex > 0,
    micDeviceId:    micSel.value,
    micSelected:    micSel.selectedIndex > 0,
  });
}

function buildStartPayload() {
  syncDevicesToApi();
  const mp3Mode = isMp3Format(formatSel.value);
  return {
    fps:            fpsSel.value,
    quality:        qualitySel.value,
    format:         formatSel.value,
    wantSysAudio:   sysAudioChk.checked,
    webcamSelected: !mp3Mode && webcamSel.selectedIndex > 0,
    webcamDeviceId: webcamSel.value,
    micSelected:    micSel.selectedIndex > 0,
    micDeviceId:    micSel.value,
    micGain:        parseFloat(micGainSlider.value),
    sysGain:        parseFloat(sysGainSlider.value),
  };
}

async function showSaveSuccessToast(fileHandle) {
  const msg = document.createDocumentFragment();
  msg.append('Gravação salva no disco. ');
  if (fileHandle) {
    try {
      const file = await fileHandle.getFile();
      const url  = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), {
        href: url, target: '_blank', rel: 'noopener noreferrer',
        textContent: 'Abrir em nova aba', className: 'toast-link',
      });
      msg.append(link);
      setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_TIMEOUT_MS);
      window.addEventListener('beforeunload', () => URL.revokeObjectURL(url), { once: true });
    } catch (_) {
      // getFile() may fail if the user moved/deleted the file; skip the link.
    }
  }
  showToast(msg, 'success');
}

function getExpectedAudioBitrate() {
  return (micSel.selectedIndex > 0 || sysAudioChk.checked) ? AUDIO_BITRATE : 0;
}

function getExpectedTotalBitrate() {
  if (isMp3Format(formatSel.value)) return getExpectedAudioBitrate();
  return (VIDEO_BITRATES[qualitySel.value] ?? VIDEO_BITRATES['720']) + getExpectedAudioBitrate();
}

function getEstimateSeconds() {
  const active = machine.state === STATE.RECORDING || machine.state === STATE.PAUSED;
  return active ? elapsedSecs : ONE_HOUR_SECONDS;
}

function updateRecordingEstimate() {
  const bitrate = getExpectedTotalBitrate();
  if (!recordingEstimateEl) return;
  if (bitrate <= 0) {
    recordingEstimateEl.textContent = isMp3Format(formatSel.value)
      ? 'Selecione um microfone ou ative o áudio do sistema para MP3.'
      : 'Selecione fontes de áudio para incluí-las na estimativa.';
    return;
  }

  const label = (machine.state === STATE.RECORDING || machine.state === STATE.PAUSED)
    ? 'Tamanho estimado'
    : 'Estimativa de 1h';
  const estimatedBytes = (bitrate / 8) * getEstimateSeconds();
  recordingEstimateEl.textContent = `${label}: ${fmtBytes(estimatedBytes)}`;
}

function updateFormatHint() {
  if (!formatHintEl) return;
  if (!isMp3Format(formatSel.value)) {
    formatHintEl.textContent = '';
    return;
  }

  formatHintEl.textContent = sysAudioChk.checked
    ? 'MP3 com áudio do sistema ainda exige compartilhamento de tela.'
    : micSel.selectedIndex > 0
      ? 'MP3 grava apenas o microfone e dispensa compartilhamento de tela.'
      : 'MP3 precisa de microfone ou áudio do sistema ativo.';
}

function updateLongRecordingAlert() {
  if (!longRecordingAlertEl) return;

  if (isMp3Format(formatSel.value)) {
    longRecordingAlertEl.hidden = true;
    longRecordingAlertEl.textContent = '';
    return;
  }

  const heavyVideoProfile = qualitySel.value !== '480' || fpsSel.value !== '15' || webcamSel.selectedIndex > 0;
  longRecordingAlertEl.hidden = false;
  longRecordingAlertEl.className = `alert ${heavyVideoProfile ? 'alert-warning' : 'alert-info'} py-2 small mb-0`;
  longRecordingAlertEl.textContent = heavyVideoProfile
    ? 'Reunião longa? Esta configuração de vídeo pode gerar arquivos grandes. Para gravações longas, prefira 480p a 15 fps, desative a webcam se ela for opcional ou use MP3 quando só precisar do áudio.'
    : 'Este é o perfil de vídeo mais leve disponível. Ainda assim, MP3 ocupa bem menos espaço quando você só precisa do áudio.';
}

function refreshAdvisoryUi() {
  updateFormatHint();
  updateLongRecordingAlert();
  updateRecordingEstimate();
}

// ── Device enumeration ────────────────────────────────────────────────────────

async function enumerateDevices() {
  try {
    const devices   = await navigator.mediaDevices.enumerateDevices();
    const videoDevs = devices.filter(d => d.kind === 'videoinput');
    const audioDevs = devices.filter(d => d.kind === 'audioinput');

    webcamSel.innerHTML = '<option value="">Nenhuma</option>';
    videoDevs.forEach((d, i) => webcamSel.add(new Option(d.label || `Câmera ${i + 1}`, d.deviceId)));

    micSel.innerHTML = '<option value="">Nenhum</option>';
    audioDevs.forEach((d, i) => micSel.add(new Option(d.label || `Microfone ${i + 1}`, d.deviceId)));

    restoreDevicePrefs();
    refreshAdvisoryUi();

    const s = machine.state;
    if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
      syncDevicesToApi();
      api.restartPreviews();
    }
  } catch (err) {
    showErrorDialog('Erro de dispositivos', 'Não foi possível listar os dispositivos: ' + err.message, err);
  }
}

// ── Preferences ────────────────────────────────────────────────────────────────

function restoreDetailsPref(detailsEl, prefKey) {
  void prefKey;
  detailsEl.open = false;
}

function restoreSimplePrefs() {
  const fps = loadPref(PREFS.fps);
  if (fps) fpsSel.value = fps;

  const quality = loadPref(PREFS.quality);
  if (quality) qualitySel.value = quality;

  const format = loadPref(PREFS.format);
  if (format) formatSel.value = format;

  const sysAudio = loadPref(PREFS.sysAudio);
  if (sysAudio !== null) sysAudioChk.checked = sysAudio === 'true';

  const storedPipX = loadPref(PREFS.pipX);
  const storedPipY = loadPref(PREFS.pipY);
  if (storedPipX !== null && storedPipY !== null) {
    compositor.pipX = parseFloat(storedPipX);
    compositor.pipY = parseFloat(storedPipY);
  }

  const micGain = loadPref(PREFS.micGain);
  if (micGain !== null) {
    micGainSlider.value      = micGain;
    micGainLabel.textContent = gainPct(micGain);
  }

  const sysGain = loadPref(PREFS.sysGain);
  if (sysGain !== null) {
    sysGainSlider.value      = sysGain;
    sysGainLabel.textContent = gainPct(sysGain);
  }

  const liveTranscriptionPref = loadPref(PREFS.liveTranscriptionEnabled);
  if (liveTranscriptionPref !== null) {
    liveTranscriptionChk.checked = liveTranscriptionPref === 'true';
  }

  const savedTranscriptionEngine = loadPref(PREFS.transcriptionEngine);
  if (savedTranscriptionEngine) {
    const selectedEngineInput = transcriptionEngineInputs.find(input => input.value === savedTranscriptionEngine);
    if (selectedEngineInput) selectedEngineInput.checked = true;
  }

  const savedPrompt = loadPref(PREFS.transcriptionPrompt);
  if (savedPrompt !== null) transcriptionPromptEl.value = savedPrompt;

  const savedTranscriptionMode = loadPref(PREFS.transcriptionMode);
  if (savedTranscriptionMode && transcriptionModeSel.querySelector(`option[value="${CSS.escape(savedTranscriptionMode)}"]`)) {
    transcriptionModeSel.value = savedTranscriptionMode;
  }

  const savedMeetingNotesPrefixEnabled = loadPref(PREFS.meetingNotesPrefixEnabled);
  if (savedMeetingNotesPrefixEnabled !== null) {
    meetingNotesPrefixEnabled = savedMeetingNotesPrefixEnabled === 'true';
  }

  const savedPostProcessModel = loadPref(PREFS.postProcessModel);
  if (savedPostProcessModel) {
    const selectedPostProcessModel = postProcessModelInputs.find(input => input.value === savedPostProcessModel);
    if (selectedPostProcessModel) selectedPostProcessModel.checked = true;
  }

  const savedPostProcessPrompt = loadPref(PREFS.postProcessPrompt);
  if (savedPostProcessPrompt !== null) postProcessPromptEl.value = savedPostProcessPrompt;

  restoreDetailsPref(openAiPanel, PREFS.openAiPanelOpen);
  restoreDetailsPref(assemblyAiPanel, PREFS.assemblyAiPanelOpen);
  restoreDetailsPref(deepSeekPanel, PREFS.deepSeekPanelOpen);
  updateTranscriptionUiCapabilities();
  updateTranscriptionModeHint();
}

function restoreDevicePrefs() {
  const webcamId = loadPref(PREFS.webcam);
  if (webcamId && webcamSel.querySelector(`option[value="${CSS.escape(webcamId)}"]`)) {
    webcamSel.value = webcamId;
  }
  const micId = loadPref(PREFS.mic);
  if (micId && micSel.querySelector(`option[value="${CSS.escape(micId)}"]`)) {
    micSel.value = micId;
  }
}

async function initializeStorageAndLibrary() {
  if (!hasFSA || !authUnlocked) return;
  await storage.init();
  await refreshMediaLibrary({ silent: true });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

if (!hasGetDisplayMedia) {
  showAlert(
    'A captura de tela não está disponível neste navegador. ' +
    'A gravação de vídeo e o áudio do sistema não funcionarão aqui, mas a gravação MP3 apenas com microfone ainda pode funcionar.',
    'warning'
  );
} else if (!hasFSA) {
  showAlert(
    'Seu navegador não oferece suporte à File System Access API, necessária para ' +
    'gravar vídeo diretamente no disco. Abra esta página no Chrome ou no Edge para usar o gravador.',
    'warning'
  );
  recorderUi.hidden = true;
  transcriptionUi.hidden = true;
}

restoreSimplePrefs();
if (!hasGetDisplayMedia) sysAudioChk.checked = false;
refreshAdvisoryUi();
render(machine.state);
updateLibrarySummary();
clearSelectedMediaState();
setTranscriptionStatus('Nenhuma transcrição em andamento.', 'muted');
setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
setPostProcessStatus('Escolha um arquivo e uma versão da transcrição para executar o pós-processamento.', 'muted');
showAuthGate('Verificando acesso salvo…', 'muted', false);
void initializeAuthentication();

// ── Event listeners ────────────────────────────────────────────────────────────

startBtn.addEventListener('click', () => {
  if (!hasGetDisplayMedia && (!isMp3Format(formatSel.value) || sysAudioChk.checked)) {
    showErrorDialog(
      'Não suportado',
      'Este navegador não consegue capturar a tela. Use MP3 apenas com microfone ou troque para um navegador desktop com suporte a captura de tela.'
    );
    return;
  }
  machine.transition(EVENT.USER_START, buildStartPayload());
});

pauseBtn.addEventListener('click', () => {
  if (machine.state === STATE.PAUSED) {
    machine.transition(EVENT.USER_RESUME, { fps: parseInt(fpsSel.value, 10) });
  } else {
    machine.transition(EVENT.USER_PAUSE);
  }
});

stopBtn.addEventListener('click', () => machine.transition(EVENT.USER_STOP));
micToggleBtn.addEventListener('click', () => {
  const muted = api.setMicMuted(!api.isMicMuted);
  trackEvent('captura_mic_toggle', { muted });
  render(machine.state);
});

endSessionBtn.addEventListener('click', () => machine.transition(EVENT.END_SESSION));

pickDirBtn.addEventListener('click', async () => {
  trackEvent('captura_folder_pick');
  const picked = await storage.pickDirectory();
  if (picked) await refreshMediaLibrary({ silent: true });
});

refreshLibraryBtn.addEventListener('click', async () => {
  if (!storage.dirHandle) {
    const picked = await storage.pickDirectory();
    if (!picked) return;
  }
  await refreshMediaLibrary({ silent: false });
});

transcribeSelectedBtn.addEventListener('click', () => {
  void transcribeSelectedMedia({ alwaysVersion: false });
});

transcribeNewVersionBtn.addEventListener('click', () => {
  void transcribeSelectedMedia({ alwaysVersion: true });
});

transcriptVersionSel.addEventListener('change', () => {
  if (selectedMediaEntry?.name) {
    selectedTranscriptNameByMedia.set(selectedMediaEntry.name, transcriptVersionSel.value);
  }
  void loadSelectedTranscript();
});

transcriptEditBtn.addEventListener('click', () => {
  toggleTranscriptEditing().catch(error => {
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: true,
      updateLivePane: false,
    });
  });
});

transcriptViewerEl.addEventListener('input', () => {
  queueTranscriptEditSave();
});

processSelectedTranscriptBtn.addEventListener('click', () => {
  void processSelectedTranscript();
});

postProcessPresetSel.addEventListener('change', () => {
  applyPostProcessPreset(postProcessPresetSel.value);
});

openAiKeyForm?.addEventListener('submit', event => event.preventDefault());
assemblyAiKeyForm?.addEventListener('submit', event => event.preventDefault());
deepSeekKeyForm?.addEventListener('submit', event => event.preventDefault());

openAiApiKeyToggleBtn.addEventListener('click', () => {
  const reveal = openAiApiKeyInput.type === 'password';
  openAiApiKeyInput.type = reveal ? 'text' : 'password';
  openAiApiKeyToggleBtn.textContent = reveal ? 'Ocultar' : 'Mostrar';
});

assemblyAiApiKeyToggleBtn.addEventListener('click', () => {
  const reveal = assemblyAiApiKeyInput.type === 'password';
  assemblyAiApiKeyInput.type = reveal ? 'text' : 'password';
  assemblyAiApiKeyToggleBtn.textContent = reveal ? 'Ocultar' : 'Mostrar';
});

deepSeekApiKeyToggleBtn.addEventListener('click', () => {
  const reveal = deepSeekApiKeyInput.type === 'password';
  deepSeekApiKeyInput.type = reveal ? 'text' : 'password';
  deepSeekApiKeyToggleBtn.textContent = reveal ? 'Ocultar' : 'Mostrar';
});

openAiPanel.addEventListener('toggle', () => {
  savePref(PREFS.openAiPanelOpen, String(openAiPanel.open));
});

assemblyAiPanel.addEventListener('toggle', () => {
  savePref(PREFS.assemblyAiPanelOpen, String(assemblyAiPanel.open));
});

deepSeekPanel.addEventListener('toggle', () => {
  savePref(PREFS.deepSeekPanelOpen, String(deepSeekPanel.open));
});

liveTranscriptionChk.addEventListener('change', () => {
  savePref(PREFS.liveTranscriptionEnabled, String(liveTranscriptionChk.checked));
  trackEvent('captura_pref_change', { pref: 'live_transcription', value: String(liveTranscriptionChk.checked) });
  if (!liveTranscriptionChk.checked && machine.state !== STATE.RECORDING && machine.state !== STATE.PAUSED) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
  }
  render(machine.state);
});

transcriptionPromptEl.addEventListener('input', () => {
  savePref(PREFS.transcriptionPrompt, transcriptionPromptEl.value);
});

transcriptionEngineInputs.forEach(input => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    savePref(PREFS.transcriptionEngine, input.value);
    trackEvent('captura_pref_change', { pref: 'transcription_engine', value: input.value });
    updateTranscriptionUiCapabilities();
    updateTranscriptionModeHint();
    render(machine.state);
  });
});

transcriptionModeSel.addEventListener('change', () => {
  savePref(PREFS.transcriptionMode, transcriptionModeSel.value);
  trackEvent('captura_pref_change', { pref: 'transcription_mode', value: transcriptionModeSel.value });
  updateTranscriptionModeHint();
  render(machine.state);
});

meetingNotesAddBtn?.addEventListener('click', () => {
  addMeetingNote();
});

meetingNotesPrefixBtn?.addEventListener('click', () => {
  meetingNotesPrefixEnabled = !meetingNotesPrefixEnabled;
  savePref(PREFS.meetingNotesPrefixEnabled, String(meetingNotesPrefixEnabled));
  trackEvent('captura_pref_change', { pref: 'meeting_notes_prefix', value: String(meetingNotesPrefixEnabled) });
  renderMeetingNotesPanel();
});

meetingNotesPostProcessChk?.addEventListener('change', () => {
  const mediaName = selectedMediaEntry?.name || '';
  if (!mediaName) {
    meetingNotesPostProcessChk.checked = false;
    return;
  }

  setMeetingNotesPostProcessEnabled(mediaName, meetingNotesPostProcessChk.checked);
  trackEvent('captura_pref_change', {
    pref: 'meeting_notes_postprocess',
    value: String(meetingNotesPostProcessChk.checked),
    file_name: mediaName,
  });
  syncMeetingNotesPostProcessControl();
  syncPostProcessOutput();
});

postProcessModelInputs.forEach(input => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    savePref(PREFS.postProcessModel, input.value);
    trackEvent('captura_pref_change', { pref: 'postprocess_model', value: input.value });
  });
});

postProcessPromptEl.addEventListener('input', () => {
  savePref(PREFS.postProcessPrompt, postProcessPromptEl.value);
});

postProcessCopyBtn.addEventListener('click', async () => {
  try {
    await copyTextToClipboard(postProcessOutputEl.value);
    showToast('Resultado copiado para a área de transferência.', 'success');
  } catch (error) {
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: false,
    });
  }
});

postProcessSaveBtn.addEventListener('click', async () => {
  try {
    await savePostProcessOutput();
  } catch (error) {
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: false,
    });
  }
});

authGateFormEl?.addEventListener('submit', event => {
  void handleAuthSubmit(event);
});

errorDialog?.addEventListener('close', () => {
  if (machine.state === STATE.ERROR) {
    machine.transition(EVENT.ERROR_DISMISSED);
  }
});

function saveAndTrackPref(key, value, analyticsKey) {
  savePref(key, value);
  trackEvent('captura_pref_change', { pref: analyticsKey, value: String(value) });
  refreshAdvisoryUi();
  render(machine.state);
}

fpsSel.addEventListener('change', () => saveAndTrackPref(PREFS.fps, fpsSel.value, 'fps'));
qualitySel.addEventListener('change', () => saveAndTrackPref(PREFS.quality, qualitySel.value, 'quality'));
formatSel.addEventListener('change', () => saveAndTrackPref(PREFS.format, formatSel.value, 'format'));
sysAudioChk.addEventListener('change', () => saveAndTrackPref(PREFS.sysAudio, sysAudioChk.checked, 'sys_audio'));

webcamSel.addEventListener('change', () => {
  savePref(PREFS.webcam, webcamSel.value);
  refreshAdvisoryUi();
  const s = machine.state;
  if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
    syncDevicesToApi();
    api.restartPreviews();
  }
});

micSel.addEventListener('change', () => {
  savePref(PREFS.mic, micSel.value);
  refreshAdvisoryUi();
  const s = machine.state;
  if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
    syncDevicesToApi();
    api.restartPreviews();
  }
});

micGainSlider.addEventListener('input', () => {
  const v = parseFloat(micGainSlider.value);
  micGainLabel.textContent = gainPct(v);
  audioMixer.setMicGain(v);
  savePref(PREFS.micGain, v);
});

sysGainSlider.addEventListener('input', () => {
  const v = parseFloat(sysGainSlider.value);
  sysGainLabel.textContent = gainPct(v);
  audioMixer.setSysGain(v);
  savePref(PREFS.sysGain, v);
});

window.addEventListener('beforeunload', () => {
  revokeSelectedPreviewUrl();
});

// ── PWA Service Worker Registration ───────────────────────────────────────────

registerServiceWorker();
