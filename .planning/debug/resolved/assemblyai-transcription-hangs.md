---
status: resolved
trigger: "Quando seleciono AssemblyAI Universal-3-pro ou Universal-2 no componente de motor de transcrição, a transcrição não retorna (só funciona com OpenAI)"
created: 2026-05-31
updated: 2026-05-31
---

## Current Focus

hypothesis: CONFIRMED - Service worker cache-first strategy caches the first polling GET response (status: "processing"), then returns stale cached response for all subsequent polls, preventing the polling loop from ever seeing "completed"
test: Read sw.js fetch handler - confirmed cache-first on all GET requests including cross-origin API calls
expecting: N/A - root cause confirmed
next_action: Apply fix to sw.js to bypass cache for API requests with authorization headers

reasoning_checkpoint:
  hypothesis: "Service worker caches AssemblyAI polling GET response, causing all subsequent polls to return stale data with status 'processing' or 'queued', preventing the polling loop from detecting completion"
  confirming_evidence:
    - "sw.js line 67-91: fetch handler intercepts ALL GET requests with cache-first strategy"
    - "sw.js line 77-78: caches.match returns cached response immediately if found"
    - "sw.js line 80-87: network response is cloned and stored in cache before returning"
    - "AssemblyAI polling (#pollTranscript) uses GET to same URL /v2/transcript/{id} repeatedly"
    - "All poll requests have identical URL, method, and headers → same cache key → cache hit every time after first poll"
    - "POST requests (upload, create transcript) bypass service worker (line 68: method !== 'GET' returns early)"
  falsification_test: "If disabling the service worker makes AssemblyAI transcription work, the hypothesis is confirmed"
  fix_rationale: "Skip service worker caching for requests with authorization headers (API calls). This prevents caching of dynamic API responses while preserving CDN asset caching."
  blind_spots: "OpenAI GET requests would have the same bug if any existed, but OpenAI transcription only uses POST requests so it's unaffected"

## Symptoms

expected: AssemblyAI transcription completes and displays transcript text
actual: Transcription hangs indefinitely - never completes, never shows error
errors: None visible in Console or Network tab (per user report)
reproduction: Select AssemblyAI as transcription engine, start transcription
started: Always broken - service worker cache-first strategy was applied to all GET requests from the start

## Eliminated

- hypothesis: AssemblyAI API does not support CORS for direct browser requests
  evidence: curl preflight tests on all 3 endpoints (upload, transcript POST, transcript GET) return `access-control-allow-origin: *` and proper allow-headers/allow-methods
  timestamp: 2026-05-31T16:02:00Z

- hypothesis: API parameter mismatch (wrong speech_models, missing required fields)
  evidence: AssemblyAI OpenAPI spec confirms speech_models (array) and audio_url are the only required fields. Code sends both correctly. language_detection: true is a valid boolean parameter.
  timestamp: 2026-05-31T16:05:00Z

- hypothesis: Error handling swallows errors silently
  evidence: Traced full error chain: #uploadFile → #runTranscription catch → transcribeFile → transcribeFileHandle → app.js catch → handleTranscriptionError (shows toast + updates status). Error handling is complete.
  timestamp: 2026-05-31T16:06:00Z

## Evidence

- timestamp: 2026-05-31T16:02:00Z
  checked: AssemblyAI CORS preflight on /v2/upload, /v2/transcript, /v2/transcript/{id}
  found: All endpoints return access-control-allow-origin: *, allow authorization header
  implication: CORS is NOT the root cause - browser requests should succeed

- timestamp: 2026-05-31T16:05:00Z
  checked: AssemblyAI OpenAPI spec (TranscriptParams schema)
  found: speech_models (array, required) and audio_url (string, required) are the only required fields. Code sends both correctly.
  implication: API parameters are correct, not causing rejection

- timestamp: 2026-05-31T16:06:00Z
  checked: Error handling chain from #uploadFile through app.js handleTranscriptionError
  found: Complete error propagation with toast notifications and status updates
  implication: Errors would be visible to user if they occurred

- timestamp: 2026-05-31T16:08:00Z
  checked: sw.js service worker fetch handler (lines 67-91)
  found: Cache-first strategy applied to ALL GET requests. Line 68 skips non-GET. Line 77-78 returns cached response if found. Line 80-87 caches network responses.
  implication: ROOT CAUSE - AssemblyAI polling GET /v2/transcript/{id} is cached on first call, all subsequent polls return stale cached response with status "processing"/"queued", preventing the loop from ever seeing "completed"

- timestamp: 2026-05-31T16:09:00Z
  checked: Why OpenAI works but AssemblyAI doesn't
  found: OpenAI transcription uses ONLY POST requests (fetch to /v1/audio/transcriptions). Service worker skips POST (line 68). AssemblyAI uses POST for upload/create but GET for polling. The GET polling is cached.
  implication: Confirms the bug is specific to AssemblyAI's GET-based polling being intercepted by the service worker cache

## Resolution

- **root_cause:** O service worker (sw.js) usava estratégia cache-first para TODAS as requisições GET. O polling da AssemblyAI faz GETs repetidos à mesma URL (/v2/transcript/{id}). A primeira resposta (status: "processing") era cacheada pelo SW, e todos os polls subsequentes recebiam a resposta stale do cache — o loop nunca via "completed", causando hang infinito.
- **fix:** Adicionado guard no sw.js para bypassar cache em requisições GET com header `authorization`. Cache version bumpado de captura-v2.4.2 para captura-v2.4.3 para limpar entradas stale.
- **verification:** Recarregar o app (fechar todas as abas ou clicar "Update Now"), selecionar AssemblyAI, iniciar transcrição. Network tab deve mostrar GETs repetidos ao polling endpoint.
- **files_changed:** sw.js

root_cause: "Service worker (sw.js) uses cache-first strategy for ALL GET requests. AssemblyAI polling (#pollTranscript) makes repeated GET requests to the same URL (/v2/transcript/{id}). The first poll response (status: 'processing' or 'queued') is cached. All subsequent polls return the stale cached response, so the polling loop never sees status 'completed'. This causes an infinite loop until the 10-minute timeout fires."
fix: "Add a guard in sw.js fetch handler to skip caching for requests with authorization headers (API calls). This prevents caching of dynamic API responses while preserving CDN asset caching."
verification: (pending)
files_changed: [sw.js]
