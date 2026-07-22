# Design: Processamento em Lote de Áudios

## [S1] Problema

O usuário recebe múltiplos áudios de reunião (ex: mensagens de voz do WhatsApp) que precisam ser processados juntos. Atualmente, cada áudio é transcrito individualmente, o que torna o fluxo tedioso para conjuntos de arquivos relacionados. A ordem dos áudios importa para o contexto da transcrição.

## [S2] Solução

Adicionar um modo de seleção múltipla à biblioteca de mídia que permite ao usuário:
1. Ativar um "Modo lote" via toggle discreto no painel de detalhes
2. Selecionar múltiplos áudios na lista
3. Definir a ordem de processamento
4. Enviar todos concatenados como um único arquivo para a API de transcrição
5. Salvar a transcrição resultante com metadados do lote

## [S3] Interface

### Switch de Modo Lote

- Localização: topo do `#media-detail-panel`, antes dos botões de ação `captura-engine-actions`
- Componente: `<label class="form-check form-switch">` com checkbox + texto "Modo lote"
- Comportamento: ao ativar, checkboxes aparecem na lista de mídia; ao desativar, seleção é limpa e checkboxes desaparecem
- Estado persistido via `localStorage` (pref key: `batchMode`)

### Checkboxes na Lista

- Ao ativar modo lote, cada item `captura-library-item` recebe um checkbox sutil à esquerda
- Apenas áudios (`kind === 'audio'`) são selecionáveis; vídeos ficam com checkbox disabled
- O item atualmente selecionado é marcado automaticamente ao entrar no modo lote
- Limite máximo: 20 arquivos por lote (razoável para API e memória)

### Painel de Ordem

- Aparece dentro do `#media-detail-panel` quando 2+ arquivos estão selecionados
- Lista compacta dos nomes dos arquivos na ordem selecionada
- Botões ▲/▼ ao lado de cada item para reordenar
- Indicador: "N arquivos selecionados"
- Botão de ação muda: "Gerar transcrição" → "Transcrever lote (N arquivos)"

## [S4] Fluxo de Execução

1. Usuário clica no toggle "Modo lote"
2. Checkboxes aparecem na lista de mídia
3. Usuário seleciona áudios (checkboxes) e define a ordem
4. Usuário clica "Transcrever lote"
5. Sistema valida: motor configurado, modo suportado
6. Sistema lê cada arquivo selecionado na ordem definida
7. Cada arquivo é normalizado via FFmpeg (mesmo fluxo existente: conversão para MP3 mono 24kHz 64kbps)
8. Arquivos normalizados são concatenados em sequência
9. Arquivo único é enviado à API de transcrição
10. Transcrição salva como `lote_DD-MM-YYYY_HHhMMmSSs-transcricao.txt`
11. Metadados salvos como `lote_DD-MM-YYYY_HHhMMmSSs-metadados.json`
12. Biblioteca é atualizada e o novo arquivo aparece na lista

## [S5] Formato dos Metadados

```json
{
  "version": 1,
  "createdAt": "2026-07-21T13:30:00.000Z",
  "files": [
    { "name": "audio1.ogg", "order": 1 },
    { "name": "audio2.ogg", "order": 2 },
    { "name": "audio3.ogg", "order": 3 }
  ],
  "engine": "assemblyai-v2",
  "mode": "plain",
  "transcriptFileName": "lote_21-07-2026_10h30m00s-transcricao.txt"
}
```

## [S6] Nomes de Arquivo

- Transcrição: `lote_DD-MM-YYYY_HHhMMmSSs-transcricao.txt` (usa `dateStamp()` existente)
- Metadados: `lote_DD-MM-YYYY_HHhMMmSSs-metadados.json`
- Sufixo de versão: `_v2`, `_v3` etc. quando já existe (mesma lógica de `writeTranscript`)
- Metadados de lote: sufixo `-metadados-lote` para não conflitar com metadados de mídia individual

## [S7] Integração com Fluxo Existente

- Reutiliza `TranscriptionController.transcribeFile()` com o arquivo concatenado
- O prompt de transcrição atual é usado para todo o lote
- Motor e modo de transcrição selecionados no painel são usados
- A concatenação usa FFmpeg WASM (já presente no projeto)
- **NÃO afeta**: gravações, transcrições individuais, pós-processamento, notas de reunião
- **NÃO modifica**: arquivos de áudio originais

## [S8] Arquitetura

### Módulos Novos

- `js/batch-processor.js` — lógica de concatenação de áudios e geração do arquivo combinado

### Módulos Modificados

- `js/app.js` — adicionar estado de modo lote, eventos de UI, integração com transcrição em lote
- `js/media-library.js` — adicionar métodos para ler/escrever metadados de lote e transcrição de lote
- `index.html` — adicionar toggle de modo lote e container do painel de ordem
- `styles/styles.css` — estilos para checkboxes, painel de ordem, e estado de seleção em lote

### Não Modificados

- `js/transcription-controller.js` — sem alterações; recebe o arquivo concatenado como input normal
- `js/storage.js` — sem alterações; usa os métodos existentes de leitura/escrita
- `js/recorder-*.js` — sem alterações
- `js/audio-mixer.js`, `js/compositor.js`, etc. — sem alterações
