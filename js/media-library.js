import { dateStamp } from './storage.js';

const AUDIO_EXTENSIONS = new Set([
  'aac', 'ac3', 'aif', 'aiff', 'amr', 'ape', 'au', 'caf', 'flac', 'm4a', 'mka',
  'mp3', 'mpga', 'oga', 'ogg', 'opus', 'wav', 'weba', 'wma', '3ga',
]);
const VIDEO_EXTENSIONS = new Set([
  'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'ogv',
  'ts', 'webm', 'wmv', '3gp', '3gpp',
]);
const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MEDIA_METADATA_SUFFIX = '-metadados';
const LEGACY_MEDIA_METADATA_SUFFIX = '-metadata';
const MEDIA_METADATA_EXTENSION = '.json';
const MEETING_NOTES_SUFFIX = '-notas';
const LEGACY_MEETING_NOTES_SUFFIX = '-notes';
const MEETING_NOTES_EXTENSION = '.json';
const TRANSCRIPT_SUFFIX = '-transcricao';
const TRANSCRIPT_LIVE_SUFFIX = '-transcricao-ao-vivo';
const LEGACY_TRANSCRIPT_SUFFIX = '-transcript';
const LEGACY_TRANSCRIPT_LIVE_SUFFIX = '-transcript-live';
const BATCH_TRANSCRIPT_SUFFIX = '-transcricao-lote';
const BATCH_METADATA_SUFFIX = '-metadados-lote';
const BATCH_METADATA_EXTENSION = '.json';

function getExtension(fileName) {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function getBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function getTranscriptStem(mediaFileName, { variant = 'final', suffix = '' } = {}) {
  const baseName = getBaseName(mediaFileName);
  if (variant === 'live') return `${baseName}${TRANSCRIPT_LIVE_SUFFIX}`;
  return suffix
    ? `${baseName}${TRANSCRIPT_SUFFIX}-${suffix}`
    : `${baseName}${TRANSCRIPT_SUFFIX}`;
}

function getLegacyTranscriptStem(mediaFileName, { variant = 'final', suffix = '' } = {}) {
  const baseName = getBaseName(mediaFileName);
  if (variant === 'live') return `${baseName}${LEGACY_TRANSCRIPT_LIVE_SUFFIX}`;
  return suffix
    ? `${baseName}${LEGACY_TRANSCRIPT_SUFFIX}-${suffix}`
    : `${baseName}${LEGACY_TRANSCRIPT_SUFFIX}`;
}

function getTranscriptStems(mediaFileName, { variant = 'final', suffix = '', includeLegacy = false } = {}) {
  const stems = [getTranscriptStem(mediaFileName, { variant, suffix })];
  if (includeLegacy) stems.push(getLegacyTranscriptStem(mediaFileName, { variant, suffix }));
  return stems;
}

function getMediaMetadataFileName(mediaFileName) {
  return `${getBaseName(mediaFileName)}${MEDIA_METADATA_SUFFIX}${MEDIA_METADATA_EXTENSION}`;
}

function getMediaMetadataFileNames(mediaFileName) {
  const baseName = getBaseName(mediaFileName);
  return [
    `${baseName}${MEDIA_METADATA_SUFFIX}${MEDIA_METADATA_EXTENSION}`,
    `${baseName}${LEGACY_MEDIA_METADATA_SUFFIX}${MEDIA_METADATA_EXTENSION}`,
  ];
}

function getMeetingNotesFileName(mediaFileName) {
  return `${getBaseName(mediaFileName)}${MEETING_NOTES_SUFFIX}${MEETING_NOTES_EXTENSION}`;
}

function getMeetingNotesFileNames(mediaFileName) {
  const baseName = getBaseName(mediaFileName);
  return [
    `${baseName}${MEETING_NOTES_SUFFIX}${MEETING_NOTES_EXTENSION}`,
    `${baseName}${LEGACY_MEETING_NOTES_SUFFIX}${MEETING_NOTES_EXTENSION}`,
  ];
}

function isTranscriptNameFor(mediaFileName, candidateName, variant = 'any') {
  const hasTxtExtension = (/\.txt$/i).test(candidateName);
  if (!hasTxtExtension) return false;

  const liveStems = getTranscriptStems(mediaFileName, { variant: 'live', includeLegacy: true });
  const finalStems = getTranscriptStems(mediaFileName, { variant: 'final', includeLegacy: true });
  const matchesStem = stem => candidateName === `${stem}.txt` || candidateName.startsWith(`${stem}-`);

  const isLiveTranscript = liveStems.some(matchesStem);
  const isFinalTranscript = finalStems.some(matchesStem) && !isLiveTranscript;

  if (variant === 'live') return isLiveTranscript;
  if (variant === 'final') return isFinalTranscript;
  return isLiveTranscript || isFinalTranscript;
}

function isBatchTranscriptNameFor(candidateName) {
  if (!(/\.txt$/i).test(candidateName)) return false;
  return candidateName.startsWith('lote_') && candidateName.includes(TRANSCRIPT_SUFFIX);
}

function getBatchMetadataFileName(batchId) {
  return `${batchId}${BATCH_METADATA_SUFFIX}${BATCH_METADATA_EXTENSION}`;
}

function getFirstEntryByName(entriesByName, fileNames) {
  return fileNames.map(fileName => entriesByName.get(fileName)).find(Boolean) || null;
}

function parseMediaMetadata(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { eventDescription: '' };
  }

  try {
    const data = JSON.parse(trimmed);
    const eventDescription = [
      data?.eventDescription,
      data?.event,
      data?.description,
      data?.notes,
    ].find(value => typeof value === 'string' && value.trim()) || '';

    return {
      eventDescription: eventDescription.trim(),
      updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : '',
      raw: data,
    };
  } catch (_) {
    return { eventDescription: trimmed };
  }
}

function normalizeMeetingNoteEntry(entry, index = 0) {
  const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
  const createdAt = typeof entry?.createdAt === 'string' ? entry.createdAt : '';
  const updatedAt = typeof entry?.updatedAt === 'string' ? entry.updatedAt : '';
  const meetingTimeSeconds = Number(entry?.meetingTimeSeconds);

  return {
    id: typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : `note-${index + 1}`,
    text,
    meetingTimeSeconds: Number.isFinite(meetingTimeSeconds) ? Math.max(0, Math.floor(meetingTimeSeconds)) : 0,
    includeMeetingTime: !!entry?.includeMeetingTime,
    createdAt,
    updatedAt,
  };
}

function parseMeetingNotes(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      version: 1,
      mediaFileName: '',
      updatedAt: '',
      notes: [],
      raw: null,
    };
  }

  try {
    const data = JSON.parse(trimmed);
    const notes = Array.isArray(data?.notes)
      ? data.notes.map(normalizeMeetingNoteEntry).filter(note => note.text)
      : [];

    return {
      version: Number.isFinite(Number(data?.version)) ? Number(data.version) : 1,
      mediaFileName: typeof data?.mediaFileName === 'string' ? data.mediaFileName : '',
      updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : '',
      notes,
      raw: data,
    };
  } catch (_) {
    return {
      version: 1,
      mediaFileName: '',
      updatedAt: '',
      notes: [],
      raw: null,
    };
  }
}

export function isMediaFileName(fileName) {
  return MEDIA_EXTENSIONS.has(getExtension(fileName));
}

export function isVideoFileName(fileName) {
  return VIDEO_EXTENSIONS.has(getExtension(fileName));
}

export function isAudioFileName(fileName) {
  return AUDIO_EXTENSIONS.has(getExtension(fileName));
}

export class MediaLibrary {
  #storage;

  constructor(storage) {
    this.#storage = storage;
  }

  async listMediaFiles() {
    const entries = await this.#storage.listDirectoryFileHandles();
    const transcriptEntries = entries.filter(entry => entry.name.toLowerCase().endsWith('.txt'));
    const metadataEntries = new Map(
      entries
        .filter(entry => entry.name.toLowerCase().endsWith(MEDIA_METADATA_EXTENSION))
        .map(entry => [entry.name, entry])
    );
    const notesEntries = new Map(
      entries
        .filter(entry => entry.name.toLowerCase().endsWith(MEETING_NOTES_EXTENSION))
        .map(entry => [entry.name, entry])
    );

    const mediaEntries = await Promise.all(
      entries
        .filter(entry => isMediaFileName(entry.name))
        .map(async entry => {
          const file = await entry.handle.getFile();
          const related = transcriptEntries.filter(candidate => isTranscriptNameFor(entry.name, candidate.name));
          const metadataEntry = getFirstEntryByName(metadataEntries, getMediaMetadataFileNames(entry.name));
          const notesEntry = getFirstEntryByName(notesEntries, getMeetingNotesFileNames(entry.name));
          let eventDescription = '';
          let notesCount = 0;

          if (metadataEntry) {
            const metadataFile = await metadataEntry.handle.getFile();
            eventDescription = parseMediaMetadata(await metadataFile.text()).eventDescription;
          }

          if (notesEntry) {
            const notesFile = await notesEntry.handle.getFile();
            notesCount = parseMeetingNotes(await notesFile.text()).notes.length;
          }

          return {
            ...entry,
            size: file.size || 0,
            lastModified: file.lastModified || 0,
            kind: isVideoFileName(entry.name) ? 'video' : 'audio',
            transcriptCount: related.length,
            eventDescription,
            eventMetadataFileName: metadataEntry ? metadataEntry.name : '',
            notesCount,
            notesFileName: notesEntry ? notesEntry.name : '',
          };
        })
    );

    return mediaEntries.sort(
      (a, b) => b.lastModified - a.lastModified || b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
    );
  }

  async getRelatedTranscripts(mediaFileName, { variant = 'any' } = {}) {
    const entries = await this.#storage.listDirectoryFileHandles();
    const candidates = entries.filter(entry => isTranscriptNameFor(mediaFileName, entry.name, variant));
    const withMeta = await Promise.all(
      candidates.map(async entry => {
        const file = await entry.handle.getFile();
        return { ...entry, lastModified: file.lastModified || 0 };
      })
    );

    return withMeta.sort(
      (a, b) => b.lastModified - a.lastModified || b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
    );
  }

  async readTranscript(handle) {
    return this.#storage.readTextFile(handle);
  }

  async getMediaEventInfo(mediaFileName) {
    const entries = await this.#storage.listDirectoryFileHandles();
    const metadataFileNames = getMediaMetadataFileNames(mediaFileName);
    const metadataEntry = metadataFileNames
      .map(fileName => entries.find(entry => entry.name === fileName))
      .find(Boolean);

    if (!metadataEntry) return null;

    const metadataFile = await metadataEntry.handle.getFile();
    const parsed = parseMediaMetadata(await metadataFile.text());
    return {
      fileName: metadataEntry.name,
      handle: metadataEntry.handle,
      lastModified: metadataFile.lastModified || 0,
      eventDescription: parsed.eventDescription,
    };
  }

  async getMediaNotesInfo(mediaFileName) {
    const entries = await this.#storage.listDirectoryFileHandles();
    const notesFileNames = getMeetingNotesFileNames(mediaFileName);
    const notesEntry = notesFileNames
      .map(fileName => entries.find(entry => entry.name === fileName))
      .find(Boolean);

    if (!notesEntry) return null;

    const notesFile = await notesEntry.handle.getFile();
    const parsed = parseMeetingNotes(await notesFile.text());
    return {
      fileName: notesEntry.name,
      handle: notesEntry.handle,
      lastModified: notesFile.lastModified || 0,
      mediaFileName: parsed.mediaFileName || mediaFileName,
      updatedAt: parsed.updatedAt || '',
      notes: parsed.notes,
    };
  }

  async deleteMediaEventInfo(mediaFileName) {
    const fileNames = getMediaMetadataFileNames(mediaFileName);
    let deleted = false;
    for (const fileName of fileNames) {
      try {
        await this.#storage.deleteFile(fileName);
        deleted = true;
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    }
    return { fileName: getMediaMetadataFileName(mediaFileName), deleted };
  }

  async writeMediaEventInfo(mediaFileName, eventDescription) {
    const trimmed = eventDescription.trim();
    const fileName = getMediaMetadataFileName(mediaFileName);
    if (!trimmed) {
      return this.deleteMediaEventInfo(mediaFileName);
    }

    const payload = JSON.stringify({
      version: 1,
      mediaFileName,
      eventDescription: trimmed,
      updatedAt: new Date().toISOString(),
    }, null, 2);
    const handle = await this.#storage.writeTextFile(fileName, `${payload}\n`);
    return { fileName, handle, eventDescription: trimmed };
  }

  async deleteMeetingNotes(mediaFileName) {
    const fileNames = getMeetingNotesFileNames(mediaFileName);
    let deleted = false;
    for (const fileName of fileNames) {
      try {
        await this.#storage.deleteFile(fileName);
        deleted = true;
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    }
    return { fileName: getMeetingNotesFileName(mediaFileName), deleted };
  }

  async writeMeetingNotes(mediaFileName, notes = []) {
    const fileName = getMeetingNotesFileName(mediaFileName);
    const normalizedNotes = Array.isArray(notes)
      ? notes
          .map((note, index) => normalizeMeetingNoteEntry(note, index))
          .map(note => ({
            ...note,
            text: note.text.trim(),
          }))
          .filter(note => note.text)
      : [];

    if (!normalizedNotes.length) {
      return this.deleteMeetingNotes(mediaFileName);
    }

    const payload = JSON.stringify({
      version: 1,
      mediaFileName,
      updatedAt: new Date().toISOString(),
      notes: normalizedNotes,
    }, null, 2);
    const handle = await this.#storage.writeTextFile(fileName, `${payload}\n`);
    return { fileName, handle, notes: normalizedNotes };
  }

  async writeTranscript(mediaFileName, transcriptText, { alwaysVersion = false, variant = 'final', suffix = '' } = {}) {
    const trimmed = transcriptText.trim();
    if (!trimmed) throw new Error('A transcrição está vazia.');

    const transcriptStem = getTranscriptStem(mediaFileName, { variant, suffix });
    const transcriptStems = getTranscriptStems(mediaFileName, { variant, suffix, includeLegacy: true });
    const entries = await this.#storage.listDirectoryFileHandles();
    const hasStem = entries.some(entry => transcriptStems.some(stem =>
      entry.name === `${stem}.txt` || ((/\.txt$/i).test(entry.name) && entry.name.startsWith(`${stem}-`))
    ));
    const fileName = !alwaysVersion && !hasStem
      ? `${transcriptStem}.txt`
      : `${transcriptStem}-${dateStamp()}.txt`;

    const handle = await this.#storage.writeTextFile(fileName, `${trimmed}\n`);
    return { fileName, handle };
  }

  async writeTranscriptFile(fileName, transcriptText) {
    if (!(/\.txt$/i).test(fileName)) {
      throw new Error('Somente arquivos .txt de transcrição podem ser editados diretamente.');
    }

    const handle = await this.#storage.writeTextFile(fileName, transcriptText);
    return { fileName, handle };
  }

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

  async writeTranscriptIncremental(mediaFileName, transcriptText, { variant = 'live', suffix = '' } = {}) {
    const trimmed = transcriptText.trim();
    if (!trimmed) throw new Error('A transcrição está vazia.');

    const fileName = `${getTranscriptStem(mediaFileName, { variant, suffix })}.txt`;
    const handle = await this.#storage.writeTextFile(fileName, `${trimmed}\n`);
    return { fileName, handle };
  }
}

export { isBatchTranscriptNameFor };
