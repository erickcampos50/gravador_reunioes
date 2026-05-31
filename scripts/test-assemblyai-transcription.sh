#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="${TEST_DIR:-"$ROOT_DIR/arquivos-teste"}"
API_KEY="${ASSEMBLYAI_API_KEY:-}"
BASE_URL="https://api.assemblyai.com"
POLL_INTERVAL_SECONDS=3
MAX_POLL_TIME_MINUTES=10

if [[ -z "$API_KEY" ]]; then
  echo "Erro: defina ASSEMBLYAI_API_KEY antes de executar este script." >&2
  echo "Exemplo: ASSEMBLYAI_API_KEY=assemblyai-... bash $0" >&2
  exit 1
fi

if [[ ! -d "$TEST_DIR" ]]; then
  echo "Erro: diretório não encontrado: $TEST_DIR" >&2
  exit 1
fi

shopt -s nullglob

files=(
  "$TEST_DIR"/*.mp3
  "$TEST_DIR"/*.m4a
  "$TEST_DIR"/*.wav
  "$TEST_DIR"/*.webm
  "$TEST_DIR"/*.mp4
  "$TEST_DIR"/*.ogg
)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "Nenhum arquivo de áudio ou vídeo encontrado em: $TEST_DIR" >&2
  exit 0
fi

upload_file() {
  local file="$1"
  echo "  Enviando $(basename "$file") para AssemblyAI…" >&2

  local upload_response
  upload_response=$(curl -sS \
    -X POST \
    -H "authorization: $API_KEY" \
    -H "content-type: application/octet-stream" \
    --data-binary "@$file" \
    "${BASE_URL}/v2/upload" 2>&1)

  local upload_url
  upload_url=$(echo "$upload_response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
url = data.get('upload_url', '')
if url:
    print(url)
" 2>/dev/null)

  if [[ -z "$upload_url" ]]; then
    echo "  Falha no upload. Resposta: $upload_response" >&2
    return 1
  fi
  echo "  Upload concluído. URL: ${upload_url:0:80}…" >&2
  # Only the URL goes to stdout
  echo "$upload_url"
}

# Build the JSON body for transcript creation using Python to handle all escaping.
# audio_url is passed via stdin to avoid shell escaping issues.
_build_transcript_json() {
  local audio_url="$1"
  local speaker_labels="$2"  # "true" or "false"
  python3 -c "
import json, sys
body = {
    'audio_url': sys.argv[1],
    'language_detection': True,
    'speech_models': ['universal-3-pro', 'universal-2'],
    'speaker_labels': sys.argv[2] == 'true',
}
print(json.dumps(body))
" "$audio_url" "$speaker_labels"
}

create_transcript_raw() {
  local json_body="$1"
  local label="${2:-transcript}"

  echo "  Criando transcrição ($label)…" >&2

  local response
  response=$(echo "$json_body" | curl -sS \
    -X POST \
    -H "authorization: $API_KEY" \
    -H "content-type: application/json" \
    -d @- \
    "${BASE_URL}/v2/transcript" 2>&1)

  local transcript_id
  transcript_id=$(echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
tid = data.get('id', '')
if tid:
    print(tid)
" 2>/dev/null)

  if [[ -z "$transcript_id" ]]; then
    echo "  Falha ao criar transcrição. Resposta: $response" >&2
    return 1
  fi
  echo "  Transcript ID: $transcript_id" >&2
  echo "$transcript_id"
}

create_transcript() {
  local audio_url="$1"
  local mode="$2"  # plain or diarized

  local speaker_labels="false"
  if [[ "$mode" == "diarized" ]]; then
    speaker_labels="true"
  fi

  local json_body
  json_body=$(_build_transcript_json "$audio_url" "$speaker_labels")

  local label
  label="$mode ($([[ "$speaker_labels" == "true" ]] && echo "diarized" || echo "universal-3-pro → universal-2"))"
  create_transcript_raw "$json_body" "$label"
}

poll_transcript() {
  local transcript_id="$1"
  local start_time
  start_time=$(date +%s)
  local max_end_time=$((start_time + MAX_POLL_TIME_MINUTES * 60))

  echo "  Aguardando conclusão da transcrição…" >&2
  while true; do
    local now
    now=$(date +%s)
    if [[ $now -ge $max_end_time ]]; then
      echo "  Tempo limite de ${MAX_POLL_TIME_MINUTES}min excedido." >&2
      return 1
    fi

    local response
    response=$(curl -sS \
      -X GET \
      -H "authorization: $API_KEY" \
      "${BASE_URL}/v2/transcript/${transcript_id}" 2>&1)

    local status
    status=$(echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('status', ''))
" 2>/dev/null)

    case "$status" in
      completed)
        echo "$response"
        return 0
        ;;
      error)
        local error_msg
        error_msg=$(echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('error', 'erro desconhecido'))
" 2>/dev/null)
        echo "  Erro na transcrição: $error_msg" >&2
        echo "  Resposta: $response" >&2
        return 1
        ;;
      *)
        ;;
    esac

    local elapsed=$((now - start_time))
    printf "  Status: %-12s  (%ds decorridos)\r" "$status" "$elapsed" >&2
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

extract_metadata() {
  python3 - "$1" <<'PY'
import json, sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)

model = data.get("speech_model_used", data.get("speech_model", ""))
duration = data.get("audio_duration", 0)
status = data.get("status", "")
utterances = data.get("utterances") or []
words = data.get("words") or []
lang = data.get("language_code", "")

print(f"status: {status}")
print(f"speech_model_used: {model}")
print(f"audio_duration: {duration}s")
print(f"language_code: {lang}")
print(f"utterances: {len(utterances)}")
print(f"words: {len(words)}")
PY
}

for file in "${files[@]}"; do
  base_name="$(basename "$file")"
  out_json="${TEST_DIR}/${base_name%.*}.assemblyai.json"
  out_txt="${TEST_DIR}/${base_name%.*}.assemblyai.txt"
  out_meta="${TEST_DIR}/${base_name%.*}.assemblyai.meta.txt"

  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Arquivo: $base_name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ── Test 1: plain text ──────────────────────────────────────
  echo "◆ Teste 1: Transcrição em modo texto normal (plain)"
  upload_url=$(upload_file "$file") || continue

  # Build JSON with speech_models fallback, matching browser behavior
  json_body=$(_build_transcript_json "$upload_url" "false")
  transcript_id=$(create_transcript_raw "$json_body" "plain (universal-3-pro → universal-2)") || continue
  result=$(poll_transcript "$transcript_id") || continue

  # Check if empty result — retry with universal-2 only (matching browser fallback)
  speech_model_used=$(echo "$result" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('speech_model_used', ''))
")
  has_text=$(echo "$result" | python3 -c "
import json, sys
d = json.load(sys.stdin)
text = d.get('text', '').strip()
if text:
    print('yes')
else:
    utils = d.get('utterances') or []
    if utils and any(u.get('text','').strip() for u in utils):
        print('yes')
    else:
        words = d.get('words') or []
        if words and any(w.get('text','').strip() for w in words):
            print('yes')
        else:
            print('no')
")

  if [[ "$has_text" == "no" && "$speech_model_used" == "universal-3-pro" ]]; then
    echo "  [FALLBACK] universal-3-pro retornou vazio → tentando universal-2…" >&2
    # Re-upload is NOT needed (reuse audio_url — though URLs may expire)
    # Better: re-upload for safety
    upload_url2=$(upload_file "$file") || continue
    json_body2=$(python3 -c "
import json, sys
body = {
    'audio_url': sys.argv[1],
    'language_detection': True,
    'speech_models': ['universal-2'],
    'speaker_labels': False,
}
print(json.dumps(body))
" "$upload_url2")
    transcript_id2=$(create_transcript_raw "$json_body2" "plain (universal-2 retry)") || continue
    result=$(poll_transcript "$transcript_id2") || continue
    echo "  [FALLBACK] Resultado com universal-2:" >&2
  fi

  echo "$result" > "$out_json"
  echo "$result" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('text', '').strip())
" > "$out_txt"

  extract_metadata "$out_json" | tee "$out_meta"
  echo "Texto da transcrição:"
  if [[ -s "$out_txt" ]]; then
    head -c 500 "$out_txt"
  else
    echo "  (texto vazio — o áudio pode não conter fala)"
  fi
  echo
  echo
  echo "  Salvo em: $out_txt"
  echo "  JSON em: $out_json"

  # ── Test 2: diarized ───────────────────────────────────────
  echo
  echo "◆ Teste 2: Transcrição com diarização (speaker_labels)"

  upload_url_d=$(upload_file "$file") || continue
  transcript_id_d=$(create_transcript "$upload_url_d" "diarized") || continue
  result_d=$(poll_transcript "$transcript_id_d") || continue

  out_json_d="${TEST_DIR}/${base_name%.*}.assemblyai-diarized.json"
  out_txt_d="${TEST_DIR}/${base_name%.*}.assemblyai-diarized.txt"
  echo "$result_d" > "$out_json_d"

  # Format diarized output
  echo "$result_d" | python3 -c "
import json, sys
data = json.load(sys.stdin)
utterances = data.get('utterances', [])
for u in utterances:
    speaker = u.get('speaker', '?')
    text = u.get('text', '').strip()
    if text:
        print(f'Speaker {speaker}: {text}')
" > "$out_txt_d"

  echo "  Salvo em: $out_txt_d"
  echo "  JSON em: $out_json_d"

  if [[ -s "$out_txt_d" ]]; then
    echo "  Segmentos diarizados (primeiros 5):"
    head -5 "$out_txt_d"
    echo
  fi

  echo
done
