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
 * @param onProgress - Progress callback
 * @returns {Promise<{ blob: Blob }>}
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

  for (const name of normalizedFiles) {
    await ffmpeg.deleteFile(name).catch(() => {});
  }
  await ffmpeg.deleteFile('concat-list.txt').catch(() => {});
  await ffmpeg.deleteFile('lote-final.mp3').catch(() => {});

  return { blob };
}
