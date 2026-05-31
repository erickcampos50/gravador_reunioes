---
status: resolved
trigger: "UI freeze durante transcricao - biblioteca ficava desabilitada (pointer-events: none)"
created: 2026-05-31T23:15:00
updated: 2026-05-31T23:25:00
symptoms:
  expected: "Navegar na biblioteca durante transcricao"
  actual: "Itens da biblioteca ficam desabilitados (cursor muda, pointer-events: none)"
  errors: "Nenhum erro visivel"
  timeline: "Desde sempre"
  reproduction: "Toda transcricao"
hypothesis: null
next_action: null
reasoning_checkpoint: null
tdd_checkpoint: null
root_cause: "A variavel transcriptionBusy era usada para desabilitar os itens da biblioteca (is-disabled com pointer-events:none). Isso era intencional para evitar conflitos, mas impedia a navegacao durante transcricoes longas."
fix: "Removido transcriptionBusy da logica de desabilitacao da biblioteca em renderMediaFileList() (app.js:1649). Agora apenas postProcessingBusy desabilita a biblioteca."
verification: "Testar navegacao na biblioteca durante transcricao de arquivo grande"
files_changed:
  - js/app.js
---

## Current Focus

hypothesis: |
  Investigating from scratch. Previous fix (setTimeout(0) after chunk processing) did not solve the issue. Need to trace exact blocking points.

next_action: |
  Trace full call stack from user click to where freeze starts. Focus on:
  1. fetchFile() - does it block?
  2. FFmpeg load() sequence - is it synchronous?
  3. ffmpeg.exec() cross-thread communication - any blocking?
  4. Any heavy computation BEFORE ffmpeg.exec()

## Evidence
<!-- Evidence entries: - timestamp: YYYY-MM-DD HH:MM - source: <file or component> - finding: <observation> -->

## Eliminated
<!-- Eliminated hypotheses: - hypothesis: <description> - why: <reason it was ruled out> - evidence: <what contradicted it> -->

## Notes
<!-- General investigation notes -->