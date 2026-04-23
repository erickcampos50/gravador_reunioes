import { dateStamp } from './storage.js';

const AUDIO_EXTENSIONS = new Set(['mp3', 'mpeg', 'mpga', 'm4a', 'wav']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);
const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MEDIA_METADATA_SUFFIX = '-metadata';
const MEDIA_METADATA_EXTENSION = '.json';
const MEETING_NOTES_SUFFIX = '-notes';
const MEETING_NOTES_EXTENSION = '.json';

function getExtension(fileName) {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function getBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function getTranscriptStem(mediaFileName, { variant = 'final', suffix = '' } = {}) {
  const baseName = getBaseName(mediaFileName);
  if (variant === 'live') return `${baseName}-transcript-live`;
  return suffix
    ? `${baseName}-transcript-${suffix}`
    : `${baseName}-transcript`;
}

function getMediaMetadataFileName(mediaFileName) {
  return `${getBaseName(mediaFileName)}${MEDIA_METADATA_SUFFIX}${MEDIA_METADATA_EXTENSION}`;
}

function getMeetingNotesFileName(mediaFileName) {
  return `${getBaseName(mediaFileName)}${MEETING_NOTES_SUFFIX}${MEETING_NOTES_EXTENSION}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTranscriptNameFor(mediaFileName, candidateName, variant = 'any') {
  const baseName = getBaseName(mediaFileName);
  const hasTxtExtension = (/\.txt$/i).test(candidateName);
  const finalBaseName = `${baseName}-transcript`;
  const liveBaseName = `${baseName}-transcript-live`;

  const isLiveTranscript = candidateName === `${liveBaseName}.txt`
    || (hasTxtExtension && candidateName.startsWith(`${liveBaseName}-`));
  const isFinalTranscript = candidateName === `${finalBaseName}.txt`
    || (hasTxtExtension && candidateName.startsWith(`${finalBaseName}-`) && !candidateName.startsWith(`${liveBaseName}-`));

  if (variant === 'live') return isLiveTranscript;
  if (variant === 'final') return isFinalTranscript;
  return isLiveTranscript || isFinalTranscript;
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
          const metadataName = getMediaMetadataFileName(entry.name);
          const metadataEntry = metadataEntries.get(metadataName);
          const notesName = getMeetingNotesFileName(entry.name);
          const notesEntry = notesEntries.get(notesName);
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
    const metadataFileName = getMediaMetadataFileName(mediaFileName);
    const entries = await this.#storage.listDirectoryFileHandles();
    const metadataEntry = entries.find(entry => entry.name === metadataFileName);

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
    const notesFileName = getMeetingNotesFileName(mediaFileName);
    const entries = await this.#storage.listDirectoryFileHandles();
    const notesEntry = entries.find(entry => entry.name === notesFileName);

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
    const fileName = getMediaMetadataFileName(mediaFileName);
    try {
      await this.#storage.deleteFile(fileName);
      return { fileName, deleted: true };
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return { fileName, deleted: false };
      }
      throw error;
    }
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
    const fileName = getMeetingNotesFileName(mediaFileName);
    try {
      await this.#storage.deleteFile(fileName);
      return { fileName, deleted: true };
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return { fileName, deleted: false };
      }
      throw error;
    }
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
    const entries = await this.#storage.listDirectoryFileHandles();
    const transcriptVersionPattern = new RegExp(`^${escapeRegExp(transcriptStem)}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.txt$`);
    const hasStem = entries.some(entry =>
      entry.name === `${transcriptStem}.txt`
      || transcriptVersionPattern.test(entry.name)
    );
    const fileName = !alwaysVersion && !hasStem
      ? `${transcriptStem}.txt`
      : `${transcriptStem}-${dateStamp()}.txt`;

    const handle = await this.#storage.writeTextFile(fileName, `${trimmed}\n`);
    return { fileName, handle };
  }

  async writeTranscriptIncremental(mediaFileName, transcriptText, { variant = 'live', suffix = '' } = {}) {
    const trimmed = transcriptText.trim();
    if (!trimmed) throw new Error('A transcrição está vazia.');

    const fileName = `${getTranscriptStem(mediaFileName, { variant, suffix })}.txt`;
    const handle = await this.#storage.writeTextFile(fileName, `${trimmed}\n`);
    return { fileName, handle };
  }
}
