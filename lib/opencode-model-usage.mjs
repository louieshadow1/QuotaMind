import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';

const JOURNAL_NAMES = new Set(['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']);
const MESSAGE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[a-z0-9][a-z0-9._:/@+~-]{0,159}$/i;
const UNKNOWN_MODELS = new Set(['unknown', 'n/a', 'none', 'null', 'undefined']);
const MIB = 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * MIB;
const MAX_DECODED_BYTES = 256 * MIB;
const MAX_FRAME_BYTES = 32 * MIB;
const MAX_LINE_LENGTH = 8 * MIB;
const MAX_FRAMES = 65_536;
const MAX_JOURNALS = 4096;
const MAX_DIRECTORIES = 8192;
const MAX_MESSAGES = 250_000;
const decoderWindowLimit = zlib.constants.ZSTD_d_windowLogMax;
const decoderParams = decoderWindowLimit === undefined ? undefined : { [decoderWindowLimit]: 26 };

let cachedRoot;
let journalCache = new Map();

async function findJournals(root) {
  const directories = [root];
  const files = [];
  let partial = false;
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    let entries;
    try {
      if (!(await fs.lstat(directory)).isDirectory()) continue;
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory !== root || error.code !== 'ENOENT') partial = true;
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (directories.length < MAX_DIRECTORIES) directories.push(path.join(directory, entry.name));
        else partial = true;
      } else if (entry.isFile() && JOURNAL_NAMES.has(entry.name)) {
        if (files.length === MAX_JOURNALS) return { files, partial: true };
        files.push(path.join(directory, entry.name));
      }
    }
  }
  return { files, partial };
}

function decodeJournal(compressed) {
  const decoder = new StringDecoder('utf8');
  const records = [];
  let partial = false;
  let pending = '';
  let droppingLine = false;
  let decodedBytes = 0;
  let frames = 0;

  function parseLine(line) {
    if (!line.trim()) return;
    if (line.length > MAX_LINE_LENGTH) {
      partial = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      partial = true;
      return;
    }
    if (event?.type !== 'assistant/message') return;
    const source = event.data?.message?.source;
    const provider = source?.provider;
    if (source?.kind !== 'model' || typeof provider !== 'string' ||
        !provider.startsWith('opencode') || !SOURCE_ID.test(provider)) return;
    const tokens = event.data.usage?.totalTokens;
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
    const id = event.data.message.id;
    if (typeof id !== 'string' || !MESSAGE_ID.test(id) || records.length >= MAX_MESSAGES) {
      partial = true;
      return;
    }
    const model = typeof source.model === 'string' && SOURCE_ID.test(source.model) &&
      !UNKNOWN_MODELS.has(source.model.toLowerCase()) ? source.model : null;
    records.push({ id: id.toLowerCase(), provider, model, tokens });
  }

  function readLines(text) {
    if (droppingLine) {
      const end = text.indexOf('\n');
      if (end === -1) return;
      text = text.slice(end + 1);
      droppingLine = false;
    }
    const buffer = pending + text;
    let start = 0;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n', start)) {
      parseLine(buffer.slice(start, end));
      start = end + 1;
    }
    pending = buffer.slice(start);
    if (pending.length > MAX_LINE_LENGTH) {
      partial = true;
      pending = '';
      droppingLine = true;
    }
  }

  let offset = 0;
  while (offset < compressed.length && frames < MAX_FRAMES && decodedBytes < MAX_DECODED_BYTES) {
    try {
      const { buffer, engine } = zlib.zstdDecompressSync(compressed.subarray(offset), {
        info: true,
        params: decoderParams,
        maxOutputLength: Math.min(MAX_FRAME_BYTES, MAX_DECODED_BYTES - decodedBytes)
      });
      const consumed = engine.bytesWritten;
      if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > compressed.length - offset) break;
      frames += 1;
      offset += consumed;
      decodedBytes += buffer.length;
      readLines(decoder.write(buffer));
    } catch {
      break;
    }
  }
  readLines(decoder.end());
  if (pending) parseLine(pending);
  return { records, readable: frames > 0, partial: partial || offset !== compressed.length };
}

function fileSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function readJournal(filename, cached) {
  const unreadable = { records: [], readable: false, partial: true };
  let file;
  try {
    const entry = await fs.lstat(filename);
    if (!entry.isFile() || entry.size > MAX_JOURNAL_BYTES) return unreadable;
    const version = fileSignature(entry);
    if (cached?.version === version) return cached;
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (fileSignature(await file.stat()) !== version) return unreadable;
    const bytes = Buffer.allocUnsafe(entry.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const decoded = decodeJournal(bytes.subarray(0, offset));
    if (fileSignature(await file.stat()) !== version) return { ...decoded, partial: true };
    return { ...decoded, version };
  } catch {
    return unreadable;
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function collectOpencodeModelUsage({ home = os.homedir() } = {}) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return { status: 'unsupported', partial: false, providers: [] };
  }
  const dsh = path.resolve(home, '.dsh');
  try {
    if (!(await fs.lstat(dsh)).isDirectory()) return { status: 'unavailable', partial: false, providers: [] };
  } catch (error) {
    return { status: 'unavailable', partial: error.code !== 'ENOENT', providers: [] };
  }

  const root = path.join(dsh, 'sessions');
  const { files, partial: traversalPartial } = await findJournals(root);
  const previousCache = root === cachedRoot ? journalCache : new Map();
  const nextCache = new Map();
  const unique = new Map();
  let partial = traversalPartial;
  let readable = false;
  let cacheMessages = 0;

  for (const filename of files) {
    const journal = await readJournal(filename, previousCache.get(filename));
    if (journal.version && cacheMessages + journal.records.length <= MAX_MESSAGES) {
      nextCache.set(filename, journal);
      cacheMessages += journal.records.length;
    }
    readable ||= journal.readable;
    partial ||= journal.partial;
    for (const record of journal.records) {
      const existing = unique.get(record.id);
      if (existing === null) continue;
      if (existing) {
        if (existing.provider !== record.provider || existing.tokens !== record.tokens ||
            (existing.model && record.model && existing.model !== record.model)) {
          // 相同消息的冲突副本归属无法确认。
          unique.set(record.id, null);
          partial = true;
        } else if (!existing.model && record.model) {
          unique.set(record.id, record);
        }
      } else if (unique.size < MAX_MESSAGES) {
        unique.set(record.id, record);
      } else {
        partial = true;
      }
    }
  }
  cachedRoot = root;
  journalCache = nextCache;

  const providers = new Map();
  for (const record of unique.values()) {
    if (!record) continue;
    const { provider, model, tokens } = record;
    if (!providers.has(provider)) providers.set(provider, { provider, models: new Map(), totalTokens: 0, unknownTokens: 0 });
    const entry = providers.get(provider);
    if (!Number.isSafeInteger(entry.totalTokens + tokens)) {
      partial = true;
      continue;
    }
    entry.totalTokens += tokens;
    if (!model) {
      entry.unknownTokens += tokens;
    } else {
      if (!entry.models.has(model)) entry.models.set(model, { name: model, tokens: 0, requests: 0 });
      const modelUsage = entry.models.get(model);
      modelUsage.tokens += tokens;
      modelUsage.requests += 1;
    }
  }
  return {
    status: readable ? 'ok' : 'unavailable',
    partial,
    providers: [...providers.values()].map(({ models, ...entry }) => ({
      ...entry,
      models: [...models.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
    })).sort((a, b) => a.provider.localeCompare(b.provider))
  };
}
