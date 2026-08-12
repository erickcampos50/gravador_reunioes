const OPENAI_TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';
const DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT = 'https://api.deepseek.com/chat/completions';

export const ASSEMBLYAI_SPEECH_MODELS = {
  v2: ['universal-2'],
  v3: ['universal-3-pro'],
};

const ASSEMBLYAI_FALLBACK_LANGUAGE_CODE = 'pt';
const ASSEMBLYAI_NO_SPOKEN_AUDIO_ERROR_RE = /language_detection cannot be performed on files with no spoken audio/i;

const OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
];
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODELS[0];

export const TRANSCRIPTION_ENGINES = {
  assemblyai: 'assemblyai',
  assemblyaiV2: 'assemblyai-v2',
  assemblyaiV3: 'assemblyai-v3',
  openai: 'openai',
};

export const TRANSCRIPTION_ENGINE_LABELS = {
  [TRANSCRIPTION_ENGINES.assemblyaiV2]: 'AssemblyAI v2',
  [TRANSCRIPTION_ENGINES.assemblyaiV3]: 'AssemblyAI v3-Pro',
  [TRANSCRIPTION_ENGINES.openai]: 'OpenAI',
};

export function getAssemblyAiSpeechModels(engineValue) {
  if (engineValue === TRANSCRIPTION_ENGINES.assemblyaiV2) {
    return ASSEMBLYAI_SPEECH_MODELS.v2;
  }
  if (engineValue === TRANSCRIPTION_ENGINES.assemblyaiV3) {
    return ASSEMBLYAI_SPEECH_MODELS.v3;
  }
  return [...ASSEMBLYAI_SPEECH_MODELS.v3, ...ASSEMBLYAI_SPEECH_MODELS.v2];
}

export function getBaseEngine(engineValue) {
  if (engineValue?.startsWith('assemblyai')) {
    return TRANSCRIPTION_ENGINES.assemblyai;
  }
  return engineValue || TRANSCRIPTION_ENGINES.openai;
}

export const OPENAI_POSTPROCESS_MODELS = [
  'gpt-5.4-mini',
  'gpt-5.6-luna',
];

export const DEEPSEEK_POSTPROCESS_MODELS = [
  'deepseek-v4-flash',
];

export const POSTPROCESS_MODELS = [
  ...OPENAI_POSTPROCESS_MODELS,
  ...DEEPSEEK_POSTPROCESS_MODELS,
];

export const DEFAULT_POSTPROCESS_MODEL = POSTPROCESS_MODELS[0];
const DEFAULT_POSTPROCESS_PROMPT = 'Reescreva a transcrição em português do Brasil, com clareza, boa fluidez e preservando o sentido original. Retorne apenas o texto final.';
const OPENAI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const ASSEMBLYAI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const ASSEMBLYAI_POLL_INTERVAL_MS = 3_000;
const OPENAI_RETRYABLE_STATUS = new Set([401, 403, 404]);
const OPENAI_RETRYABLE_MESSAGE_RE = /(model|access|permission|available|not found|does not exist|unsupported)/i;

export const TRANSCRIPTION_OUTPUT_MODES = {
  plain: 'plain',
  timestamps: 'timestamps',
  diarized: 'diarized',
};

export const TRANSCRIPTION_OUTPUT_MODE_LABELS = {
  [TRANSCRIPTION_OUTPUT_MODES.plain]: 'Texto normal',
  [TRANSCRIPTION_OUTPUT_MODES.timestamps]: 'Segmentos com timestamp',
  [TRANSCRIPTION_OUTPUT_MODES.diarized]: 'Diarização',
};

export const TRANSCRIPTION_OUTPUT_MODE_SUFFIXES = {
  [TRANSCRIPTION_OUTPUT_MODES.plain]: '',
  [TRANSCRIPTION_OUTPUT_MODES.timestamps]: 'segmentos',
  [TRANSCRIPTION_OUTPUT_MODES.diarized]: 'diarizado',
};

class OpenAIRequestError extends Error {
  constructor(message, { status = null, model = '', requestId = '', cause = null } = {}) {
    super(message);
    this.name = 'OpenAIRequestError';
    this.status = status;
    this.model = model;
    this.requestId = requestId;
    if (cause) this.cause = cause;
  }
}

export class TranscriptionConfigError extends Error {
  constructor(message, { name = 'TranscriptionConfigError', title = 'Configuração obrigatória', engine = '' } = {}) {
    super(message);
    this.name = name;
    this.title = title;
    this.engine = engine;
  }
}

export class OpenAIConfigError extends TranscriptionConfigError {
  constructor(message) {
    super(message, {
      name: 'OpenAIConfigError',
      title: 'Chave da API da OpenAI obrigatória',
      engine: TRANSCRIPTION_ENGINES.openai,
    });
  }
}

export class AssemblyAIConfigError extends TranscriptionConfigError {
  constructor(message) {
    super(message, {
      name: 'AssemblyAIConfigError',
      title: 'Chave da API da AssemblyAI obrigatória',
      engine: TRANSCRIPTION_ENGINES.assemblyai,
    });
  }
}

export class DeepSeekConfigError extends TranscriptionConfigError {
  constructor(message) {
    super(message, {
      name: 'DeepSeekConfigError',
      title: 'Chave da API da DeepSeek obrigatória',
      engine: 'deepseek',
    });
  }
}

export function isDeepSeekPostProcessModel(model) {
  return DEEPSEEK_POSTPROCESS_MODELS.includes(model);
}

function createRequestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;

  const forwardAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    },
  };
}

function isLikelyBrowserFetchError(error) {
  return error instanceof TypeError && /Failed to fetch/i.test(error.message || '');
}

function formatTimeoutLabel(timeoutMs) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
}

function extractResponseText(data) {
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

function extractChatCompletionText(data) {
  if (!Array.isArray(data?.choices)) return '';

  return data.choices
    .map(choice => {
      const content = choice?.message?.content;
      if (typeof content === 'string') return content.trim();
      if (!Array.isArray(content)) return '';
      return content
        .map(item => (typeof item?.text === 'string' ? item.text.trim() : ''))
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function normalizeTranscriptionSegments(data) {
  if (!Array.isArray(data?.segments)) return [];

  return data.segments
    .map(segment => {
      const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
      if (!text) return null;

      const start = Number(segment?.start);
      const end = Number(segment?.end);

      return {
        id: typeof segment?.id === 'string' ? segment.id : '',
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : 0,
        text,
        speaker: typeof segment?.speaker === 'string' ? segment.speaker.trim() : '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }));
}

async function parseOpenAiErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  const requestId = response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      const message = data?.error?.message || data?.message || `A requisição para a OpenAI falhou com status ${response.status}.`;
      return requestId ? `${message} (request id: ${requestId})` : message;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  const message = text || `A requisição para a OpenAI falhou com status ${response.status}.`;
  return requestId ? `${message} (request id: ${requestId})` : message;
}

async function parseDeepSeekErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return data?.error?.message || data?.message || `A requisição para a DeepSeek falhou com status ${response.status}.`;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  return text || `A requisição para a DeepSeek falhou com status ${response.status}.`;
}

async function readOpenAiErrorResponse(response, model) {
  return new OpenAIRequestError(await parseOpenAiErrorMessage(response), {
    status: response.status,
    model,
    requestId: response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '',
  });
}

function shouldRetryTranscriptionError(error, model, models) {
  if (!(error instanceof OpenAIRequestError)) return false;
  if (!OPENAI_RETRYABLE_STATUS.has(error.status)) return false;
  if (!OPENAI_RETRYABLE_MESSAGE_RE.test(error.message)) return false;
  return model !== models[models.length - 1];
}

async function parseAssemblyAiErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return data?.error || data?.message || `A requisição para a AssemblyAI falhou com status ${response.status}.`;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  return text || `A requisição para a AssemblyAI falhou com status ${response.status}.`;
}

function getAssemblyAiWordText(word) {
  return (typeof word?.text === 'string' ? word.text : word?.word || '').trim();
}

function extractAssemblyAiTranscriptText(data) {
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (text) return text;

  const utterances = Array.isArray(data?.utterances) ? data.utterances : [];
  const utteranceText = utterances
    .map(utterance => (typeof utterance?.text === 'string' ? utterance.text.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (utteranceText) return utteranceText;

  const words = Array.isArray(data?.words) ? data.words : [];
  return words
    .map(getAssemblyAiWordText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function hasAssemblyAiTranscriptContent(data) {
  return !!extractAssemblyAiTranscriptText(data);
}

function getAssemblyAiSpeechModelUsed(data) {
  return typeof data?.speech_model_used === 'string' && data.speech_model_used.trim()
    ? data.speech_model_used.trim()
    : (typeof data?.speech_model === 'string' ? data.speech_model.trim() : '');
}

function isNoSpokenAudioLanguageDetectionError(error) {
  return ASSEMBLYAI_NO_SPOKEN_AUDIO_ERROR_RE.test(error?.message || '');
}

function createAssemblyAiEmptyTranscriptError(data) {
  const duration = Number(data?.audio_duration);
  const durationLabel = Number.isFinite(duration) && duration > 0
    ? ` Duração detectada: ${Math.round(duration)}s.`
    : '';
  const model = getAssemblyAiSpeechModelUsed(data);
  const modelLabel = model ? ` Modelo usado: ${model}.` : '';
  return new Error(
    'A AssemblyAI concluiu a transcrição, mas não encontrou fala suficiente para gerar texto.' +
    durationLabel +
    modelLabel +
    ' Verifique se a gravação contém áudio de voz audível.'
  );
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('A operação foi cancelada.', 'AbortError'));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('A operação foi cancelada.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class OpenAIClientManager {
  #apiKeyInput;

  engine = TRANSCRIPTION_ENGINES.openai;
  supportsPrompt = true;
  supportsStructuredTranscription = true;
  supportsPostProcess = true;
  supportedModes = new Set(Object.values(TRANSCRIPTION_OUTPUT_MODES));

  constructor(apiKeyInput) {
    this.#apiKeyInput = apiKeyInput;
  }

  getApiKey() {
    return this.#apiKeyInput?.value.trim() || '';
  }

  assertConfigured() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new OpenAIConfigError('Preencha sua chave da API da OpenAI antes de usar a transcrição ou o pós-processamento.');
    }
    return apiKey;
  }

  async transcribeFile({ file, prompt = '', signal, model } = {}) {
    const apiKey = this.assertConfigured();
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    const models = [...new Set([model || DEFAULT_OPENAI_TRANSCRIPTION_MODEL, ...OPENAI_TRANSCRIPTION_MODELS])];
    let lastError = null;

    for (const candidateModel of models) {
      try {
        return await this.#transcribeFileOnce({
          apiKey,
          file,
          prompt,
          signal,
          model: candidateModel,
        });
      } catch (error) {
        lastError = error;
        if (!shouldRetryTranscriptionError(error, candidateModel, models)) {
          throw error;
        }
      }
    }

    if (lastError) throw lastError;
    throw new Error('Não foi possível transcrever o arquivo selecionado.');
  }

  async transcribeFileDetailed({ file, prompt = '', signal, mode = TRANSCRIPTION_OUTPUT_MODES.timestamps } = {}) {
    const apiKey = this.assertConfigured();
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    if (mode === TRANSCRIPTION_OUTPUT_MODES.timestamps) {
      return await this.#transcribeStructuredFileOnce({
        apiKey,
        file,
        prompt,
        signal,
        model: 'whisper-1',
        responseFormat: 'verbose_json',
        timestampGranularities: ['segment'],
      });
    }

    if (mode === TRANSCRIPTION_OUTPUT_MODES.diarized) {
      return await this.#transcribeStructuredFileOnce({
        apiKey,
        file,
        signal,
        model: 'gpt-4o-transcribe-diarize',
        responseFormat: 'diarized_json',
        chunkingStrategy: 'auto',
      });
    }

    throw new Error(`Modo de transcrição estruturada inválido: ${mode}.`);
  }

  async #transcribeFileOnce({ apiKey, file, prompt, signal, model }) {
    const formData = new FormData();
    formData.append('file', file, file.name || 'audio.webm');
    formData.append('model', model);
    if (prompt.trim()) formData.append('prompt', prompt.trim());

    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, OPENAI_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: requestSignal,
      });

      if (!response.ok) {
        throw await readOpenAiErrorResponse(response, model);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        return typeof data?.text === 'string' ? data.text.trim() : '';
      }

      return (await response.text()).trim();
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com ${model} excedeu o tempo limite de ${formatTimeoutLabel(OPENAI_REQUEST_TIMEOUT_MS)}.`);
      }

      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          `Não foi possível conectar à OpenAI ao transcrever com ${model}. ` +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  async #transcribeStructuredFileOnce({
    apiKey,
    file,
    prompt = '',
    signal,
    model,
    responseFormat,
    timestampGranularities = [],
    chunkingStrategy = '',
  }) {
    const formData = new FormData();
    formData.append('file', file, file.name || 'audio.webm');
    formData.append('model', model);
    if (prompt.trim() && responseFormat !== 'diarized_json') formData.append('prompt', prompt.trim());
    if (responseFormat) formData.append('response_format', responseFormat);
    timestampGranularities.forEach(value => formData.append('timestamp_granularities[]', value));
    if (chunkingStrategy) formData.append('chunking_strategy', chunkingStrategy);

    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, OPENAI_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: requestSignal,
      });

      if (!response.ok) {
        throw await readOpenAiErrorResponse(response, model);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = (await response.text()).trim();
        return { text, raw: null, segments: [], model };
      }

      const data = await response.json();
      const text = typeof data?.text === 'string'
        ? data.text.trim()
        : extractResponseText(data);

      return {
        text,
        raw: data,
        segments: normalizeTranscriptionSegments(data),
        model,
      };
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com ${model} excedeu o tempo limite de ${formatTimeoutLabel(OPENAI_REQUEST_TIMEOUT_MS)}.`);
      }

      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          `Não foi possível conectar à OpenAI ao transcrever com ${model}. ` +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  async postProcessText({ text, prompt = '', signal, model = DEFAULT_POSTPROCESS_MODEL } = {}) {
    const apiKey = this.assertConfigured();
    const transcriptText = text?.trim() || '';
    if (!transcriptText) {
      throw new Error('Não há texto de transcrição disponível para pós-processamento.');
    }

    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
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
                text: 'Você reescreve transcrições. Retorne apenas o texto final reformulado, sem título, sem prefácio e sem comentários extras, exceto quando isso for solicitado.',
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
      throw new Error(await parseOpenAiErrorMessage(response));
    }

    const data = await response.json();
    const outputText = extractResponseText(data);
    if (!outputText) {
      throw new Error('A OpenAI retornou um resultado vazio no pós-processamento.');
    }

    return outputText;
  }
}

export class DeepSeekClientManager {
  #apiKeyInput;

  supportsPostProcess = true;

  constructor(apiKeyInput) {
    this.#apiKeyInput = apiKeyInput;
  }

  getApiKey() {
    return this.#apiKeyInput?.value.trim() || '';
  }

  assertConfigured() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new DeepSeekConfigError('Preencha sua chave da API da DeepSeek antes de usar o pós-processamento com deepseek-v4-flash.');
    }
    return apiKey;
  }

  async postProcessText({ text, prompt = '', signal, model = DEEPSEEK_POSTPROCESS_MODELS[0] } = {}) {
    const apiKey = this.assertConfigured();
    const transcriptText = text?.trim() || '';
    if (!transcriptText) {
      throw new Error('Não há texto de transcrição disponível para pós-processamento.');
    }

    let response;
    try {
      response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'Você reescreve transcrições. Retorne apenas o texto final reformulado, sem título, sem prefácio e sem comentários extras, exceto quando isso for solicitado.',
            },
            {
              role: 'user',
              content: [
                `Instrução:\n${prompt.trim() || DEFAULT_POSTPROCESS_PROMPT}`,
                `Transcrição:\n${transcriptText}`,
              ].join('\n\n'),
            },
          ],
        }),
        signal,
      });
    } catch (error) {
      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          `Não foi possível conectar à DeepSeek ao processar com ${model}. ` +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(await parseDeepSeekErrorMessage(response));
    }

    const data = await response.json();
    const outputText = extractChatCompletionText(data);
    if (!outputText) {
      throw new Error('A DeepSeek retornou um resultado vazio no pós-processamento.');
    }

    return outputText;
  }
}

export class AssemblyAIClientManager {
  #apiKeyInput;

  engine = TRANSCRIPTION_ENGINES.assemblyai;
  supportsPrompt = false;
  supportsStructuredTranscription = true;
  supportsPostProcess = false;
  supportedModes = new Set([
    TRANSCRIPTION_OUTPUT_MODES.plain,
    TRANSCRIPTION_OUTPUT_MODES.diarized,
  ]);

  constructor(apiKeyInput) {
    this.#apiKeyInput = apiKeyInput;
  }

  getApiKey() {
    return this.#apiKeyInput?.value.trim() || '';
  }

  assertConfigured() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AssemblyAIConfigError('Preencha sua chave da API da AssemblyAI antes de usar este motor de transcrição.');
    }
    return apiKey;
  }

  async transcribeFile({ file, signal, speechModels } = {}) {
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    const result = await this.#runTranscription({ file, signal, speakerLabels: false, speechModels });
    const text = extractAssemblyAiTranscriptText(result);
    if (!text) throw createAssemblyAiEmptyTranscriptError(result);
    return text;
  }

  async transcribeFileDetailed({
    file,
    signal,
    mode = TRANSCRIPTION_OUTPUT_MODES.diarized,
    speechModels,
  } = {}) {
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }
    if (mode !== TRANSCRIPTION_OUTPUT_MODES.diarized) {
      throw new Error(`Modo de transcrição estruturada inválido para AssemblyAI: ${mode}.`);
    }

    const result = await this.#runTranscription({ file, signal, speakerLabels: true, speechModels });
    const transcriptText = extractAssemblyAiTranscriptText(result);
    if (!transcriptText) throw createAssemblyAiEmptyTranscriptError(result);

    const utterances = Array.isArray(result?.utterances) ? result.utterances : [];
    const segments = utterances
      .map((utterance, index) => {
        const text = typeof utterance?.text === 'string' ? utterance.text.trim() : '';
        if (!text) return null;

        const start = Number(utterance?.start);
        const end = Number(utterance?.end);
        const speaker = typeof utterance?.speaker === 'string' && utterance.speaker.trim()
          ? `Speaker ${utterance.speaker.trim()}`
          : '';

        return {
          id: `utterance-${index + 1}`,
          start: Number.isFinite(start) ? start / 1000 : 0,
          end: Number.isFinite(end) ? end / 1000 : 0,
          text,
          speaker,
        };
      })
      .filter(Boolean);

    return {
      text: transcriptText,
      raw: result,
      segments,
      speechModels: speechModels || [...ASSEMBLYAI_SPEECH_MODELS.v3, ...ASSEMBLYAI_SPEECH_MODELS.v2],
    };
  }

  async #runTranscription({ file, signal, speakerLabels = false, speechModels } = {}) {
    const apiKey = this.assertConfigured();
    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, ASSEMBLYAI_REQUEST_TIMEOUT_MS);
    const models = speechModels || [...ASSEMBLYAI_SPEECH_MODELS.v3, ...ASSEMBLYAI_SPEECH_MODELS.v2];

    try {
      const audioUrl = await this.#uploadFile(file, apiKey, requestSignal);
      let result;
      try {
        result = await this.#createAndPollTranscript(audioUrl, apiKey, requestSignal, {
          speakerLabels,
          speechModels: models,
        });
      } catch (error) {
        if (!isNoSpokenAudioLanguageDetectionError(error)) {
          throw error;
        }
        result = await this.#createAndPollTranscript(audioUrl, apiKey, requestSignal, {
          speakerLabels,
          speechModels: models,
          languageCode: ASSEMBLYAI_FALLBACK_LANGUAGE_CODE,
        });
      }

      if (hasAssemblyAiTranscriptContent(result)) {
        return result;
      }

      if (speechModels) {
        throw createAssemblyAiEmptyTranscriptError(result);
      }

      const speechModelUsed = getAssemblyAiSpeechModelUsed(result);
      if (speechModelUsed && speechModelUsed !== 'universal-3-pro') {
        return result;
      }

      return await this.#createAndPollTranscript(audioUrl, apiKey, requestSignal, {
        speakerLabels,
        speechModels: ASSEMBLYAI_SPEECH_MODELS.v2,
      });
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com a AssemblyAI excedeu o tempo limite de ${formatTimeoutLabel(ASSEMBLYAI_REQUEST_TIMEOUT_MS)}.`);
      }

      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          'Não foi possível conectar à AssemblyAI. ' +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  async #createAndPollTranscript(audioUrl, apiKey, signal, { speakerLabels = false, speechModels = ASSEMBLYAI_SPEECH_MODELS, languageCode = '' } = {}) {
    const transcriptId = await this.#createTranscript(audioUrl, apiKey, signal, { speakerLabels, speechModels, languageCode });
    if (!transcriptId) {
      throw new Error('A AssemblyAI não retornou um identificador de transcrição.');
    }

    while (true) {
      const pollingData = await this.#pollTranscript(transcriptId, apiKey, signal);
      if (pollingData?.status === 'completed') {
        return pollingData;
      }
      if (pollingData?.status === 'error') {
        throw new Error(`A AssemblyAI falhou ao transcrever: ${pollingData?.error || 'erro desconhecido.'}`);
      }
      await delay(ASSEMBLYAI_POLL_INTERVAL_MS, signal);
    }
  }

  async #uploadFile(file, apiKey, signal) {
    const uploadResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/upload`, {
      method: 'POST',
      headers: {
        authorization: apiKey,
      },
      body: file,
      signal,
    });

    if (!uploadResponse.ok) {
      throw new Error(await parseAssemblyAiErrorMessage(uploadResponse));
    }

    const uploadData = await uploadResponse.json();
    const audioUrl = typeof uploadData?.upload_url === 'string' ? uploadData.upload_url : '';
    if (!audioUrl) {
      throw new Error('A AssemblyAI não retornou uma URL de upload válida.');
    }

    return audioUrl;
  }

  async #createTranscript(audioUrl, apiKey, signal, { speakerLabels = false, speechModels = ASSEMBLYAI_SPEECH_MODELS, languageCode = '' } = {}) {
    const transcriptResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        ...(languageCode
          ? { language_code: languageCode }
          : { language_detection: true }),
        speech_models: [...speechModels],
        ...(speakerLabels ? { speaker_labels: true } : {}),
      }),
      signal,
    });

    if (!transcriptResponse.ok) {
      throw new Error(await parseAssemblyAiErrorMessage(transcriptResponse));
    }

    const transcriptData = await transcriptResponse.json();
    return typeof transcriptData?.id === 'string' ? transcriptData.id : '';
  }

  async #pollTranscript(transcriptId, apiKey, signal) {
    const pollingResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript/${transcriptId}`, {
      method: 'GET',
      headers: {
        authorization: apiKey,
      },
      signal,
    });

    if (!pollingResponse.ok) {
      throw new Error(await parseAssemblyAiErrorMessage(pollingResponse));
    }

    return pollingResponse.json();
  }
}
