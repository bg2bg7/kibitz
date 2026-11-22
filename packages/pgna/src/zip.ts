import { compilePgna } from "./compiler.js";
import type {
  ArchiveEntry,
  PgnaDiagnostic,
  PgnaManifest,
  PgnaTimeline,
  ZipCompressionMethod,
} from "./types.js";
import { ZIP_METHOD_DEFLATE, ZIP_METHOD_STORE, isSafeArchivePath } from "./validator.js";

export interface PackPgnaOptions {
  /** Entry paths that must be stored uncompressed (method 0) — mandatory for audio clips. */
  storePaths?: ReadonlySet<string>;
}

export interface PackPgnaArchiveInput {
  manifest: PgnaManifest;
  pgnText: string;
  /** Map of clip archive path -> raw audio bytes (stored uncompressed with ZIP method 0). */
  audioByPath?: Record<string, Uint8Array>;
  /** Map of per-clip WebVTT archive path -> raw VTT text (compressed with ZIP method 8). */
  subtitlesByPath?: Record<string, string>;
  /** Optional deterministic ISO timestamp for `timeline.compiledAt`. */
  compiledAt?: string;
}

export interface PackPgnaArchiveResult {
  zipBytes: Uint8Array;
  entries: ArchiveEntry[];
  timeline: PgnaTimeline;
  mergedSubtitlesVtt: Record<string, string>;
  diagnostics: PgnaDiagnostic[];
}

export interface UnpackedPgnaArchive {
  entries: ArchiveEntry[];
  manifest: PgnaManifest;
  pgnText: string;
  timeline: PgnaTimeline;
  audioByPath: Record<string, Uint8Array>;
  subtitlesByPath: Record<string, string>;
}

/**
 * Minimal ambient types for standard Web Streams / TextCodec globals available
 * natively in Node.js >= 22 and modern browsers without requiring DOM lib.
 */
interface MinimalReadableStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}
interface MinimalWritableStreamWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface MinimalTransformStream {
  readable: { getReader(): MinimalReadableStreamReader };
  writable: { getWriter(): MinimalWritableStreamWriter };
}
interface GlobalWebApiSurface {
  TextEncoder?: new () => { encode(input: string): Uint8Array };
  TextDecoder?: new (label?: string) => { decode(input: Uint8Array): string };
  CompressionStream?: new (format: string) => MinimalTransformStream;
  DecompressionStream?: new (format: string) => MinimalTransformStream;
}

const webGlobals = globalThis as unknown as GlobalWebApiSurface;

export function utf8Encode(text: string): Uint8Array {
  if (webGlobals.TextEncoder) {
    return new webGlobals.TextEncoder().encode(text);
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(++i);
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  if (webGlobals.TextDecoder) {
    return new webGlobals.TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++]! & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++]! & 0x3f;
      const b2 = bytes[i++]! & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = bytes[i++]! & 0x3f;
      const b2 = bytes[i++]! & 0x3f;
      const b3 = bytes[i++]! & 0x3f;
      const cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      const offset = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    }
  }
  return out;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runTransformStream(
  stream: MinimalTransformStream,
  input: Uint8Array,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = writer.write(input).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
    }
  }

  await writePromise;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (!webGlobals.CompressionStream) {
    throw new Error("CompressionStream('deflate-raw') is not available in this runtime.");
  }
  return runTransformStream(new webGlobals.CompressionStream("deflate-raw"), data);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (!webGlobals.DecompressionStream) {
    throw new Error("DecompressionStream('deflate-raw') is not available in this runtime.");
  }
  return runTransformStream(new webGlobals.DecompressionStream("deflate-raw"), data);
}

/**
 * Returns true if an archive path is extraneous OS metadata that readers should ignore
 * when scanning unreferenced files per PGNA v1.0 §2.1.
 */
export function isOsMetadataPath(entryPath: string): boolean {
  return (
    entryPath.startsWith("__MACOSX/") ||
    entryPath === ".DS_Store" ||
    entryPath.endsWith("/.DS_Store")
  );
}

/**
 * Resolves the required ZIP compression method per PGNA v1.0 §2:
 * STORE (0) for audio clips, DEFLATE (8) for JSON, PGN, and WebVTT.
 */
export function resolveCompressionMethod(
  entryPath: string,
  storePaths: ReadonlySet<string>,
): typeof ZIP_METHOD_STORE | typeof ZIP_METHOD_DEFLATE {
  return storePaths.has(entryPath) ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
}

/**
 * Validates archive entries prior to ZIP packing.
 */
export function prepareArchiveEntries(
  files: ReadonlyArray<{ path: string; data: Uint8Array }>,
  options: PackPgnaOptions = {},
): ArchiveEntry[] {
  const storePaths = options.storePaths ?? new Set<string>();
  return files.map((file) => {
    if (!isSafeArchivePath(file.path)) {
      throw new Error(`Unsafe PGNA archive path: "${file.path}"`);
    }
    return {
      path: file.path,
      data: file.data,
      compressionMethod: resolveCompressionMethod(file.path, storePaths),
    };
  });
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

/**
 * Packs prepared ArchiveEntry records into a standard PKWARE ZIP archive honoring exact
 * per-entry compression methods (0 = STORE, 8 = DEFLATE) and UTF-8 filenames.
 */
export async function packPgnaZip(entries: readonly ArchiveEntry[]): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) {
      throw new Error(`Unsafe PGNA archive path: "${entry.path}"`);
    }

    const nameBytes = utf8Encode(entry.path);
    const uncompressedData = entry.data;
    const crc32 = computeCrc32(uncompressedData);

    const payload =
      entry.compressionMethod === ZIP_METHOD_DEFLATE
        ? await deflateRaw(uncompressedData)
        : uncompressedData;

    // Local File Header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
    lv.setUint16(4, 20, true); // version needed to extract (2.0)
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, entry.compressionMethod, true);
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc32, true);
    lv.setUint32(18, payload.byteLength, true);
    lv.setUint32(22, uncompressedData.byteLength, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field len
    localHeader.set(nameBytes, 30);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, entry.compressionMethod, true);
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc32, true);
    cv.setUint32(20, payload.byteLength, true);
    cv.setUint32(24, uncompressedData.byteLength, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + payload.byteLength;
  }

  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.byteLength;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir start disk
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true); // zip comment length

  const totalSize = localOffset + centralSize + eocd.byteLength;
  const output = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) {
    output.set(part, pos);
    pos += part.byteLength;
  }
  for (const part of centralParts) {
    output.set(part, pos);
    pos += part.byteLength;
  }
  output.set(eocd, pos);

  return output;
}

/**
 * Unpacks a PKWARE ZIP archive into ArchiveEntry records, preserving exact compression methods
 * (`0` = STORE, `8` = DEFLATE), verifying CRC-32 checksums, and rejecting unsafe paths.
 */
export async function unpackPgnaZip(zipBytes: Uint8Array): Promise<ArchiveEntry[]> {
  if (zipBytes.byteLength < 22) {
    throw new Error("Invalid ZIP archive: file too short.");
  }

  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

  // Locate EOCD record searching backwards (up to 65535 + 22 bytes from end)
  const minEocdOffset = Math.max(0, zipBytes.byteLength - 65557);
  let eocdOffset = -1;
  for (let i = zipBytes.byteLength - 22; i >= minEocdOffset; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === zipBytes.byteLength) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP archive: End of Central Directory record not found.");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (centralDirOffset + centralDirSize > zipBytes.byteLength) {
    throw new Error("Invalid ZIP archive: Central Directory extends past EOF.");
  }

  const entries: ArchiveEntry[] = [];
  let cursor = centralDirOffset;

  for (let idx = 0; idx < entryCount; idx++) {
    if (cursor + 46 > zipBytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error(`Invalid ZIP archive: corrupt Central Directory header at entry ${idx}.`);
    }

    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameBytes = zipBytes.subarray(cursor + 46, cursor + 46 + nameLen);
    const entryPath = utf8Decode(nameBytes);
    cursor += 46 + nameLen + extraLen + commentLen;

    // Skip directory entries
    if (entryPath.endsWith("/")) {
      continue;
    }

    if (!isSafeArchivePath(entryPath)) {
      throw new Error(`Unsafe PGNA archive path: "${entryPath}"`);
    }

    if (
      localHeaderOffset + 30 > zipBytes.byteLength ||
      view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIG
    ) {
      throw new Error(`Invalid ZIP archive: corrupt Local File Header for "${entryPath}".`);
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBytes.byteLength) {
      throw new Error(`Invalid ZIP archive: compressed data truncated for "${entryPath}".`);
    }

    const rawPayload = zipBytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === ZIP_METHOD_STORE) {
      data = new Uint8Array(rawPayload);
    } else if (method === ZIP_METHOD_DEFLATE) {
      data = await inflateRaw(rawPayload);
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${method} for "${entryPath}" (only STORE=0 and DEFLATE=8 are supported).`,
      );
    }

    if (data.byteLength !== uncompressedSize) {
      throw new Error(
        `ZIP size mismatch for "${entryPath}": expected ${uncompressedSize} bytes, got ${data.byteLength}.`,
      );
    }

    const actualCrc = computeCrc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`ZIP CRC-32 mismatch for "${entryPath}".`);
    }

    entries.push({
      path: entryPath,
      compressionMethod: method as ZipCompressionMethod,
      data,
    });
  }

  return entries;
}

/**
 * Compiles `manifest` + `pgnText` + subtitles and packs a complete spec-compliant `.pgna` ZIP archive.
 */
export async function packPgnaArchive(
  input: PackPgnaArchiveInput,
): Promise<PackPgnaArchiveResult> {
  const compiled = compilePgna({
    manifest: input.manifest,
    pgnText: input.pgnText,
    subtitlesByPath: input.subtitlesByPath,
    compiledAt: input.compiledAt,
  });

  const audioPaths = new Set<string>();
  for (const clip of Object.values(input.manifest.clips)) {
    audioPaths.add(clip.path);
  }
  if (input.audioByPath) {
    for (const p of Object.keys(input.audioByPath)) {
      audioPaths.add(p);
    }
  }

  const rawFiles: Array<{ path: string; data: Uint8Array }> = [
    { path: "manifest.json", data: utf8Encode(JSON.stringify(input.manifest, null, 2)) },
    { path: input.manifest.pgnPath, data: utf8Encode(input.pgnText) },
    { path: input.manifest.timelinePath, data: utf8Encode(JSON.stringify(compiled.timeline, null, 2)) },
  ];

  if (input.audioByPath) {
    for (const [audioPath, bytes] of Object.entries(input.audioByPath)) {
      rawFiles.push({ path: audioPath, data: bytes });
    }
  }

  if (input.subtitlesByPath) {
    for (const [subPath, vttText] of Object.entries(input.subtitlesByPath)) {
      rawFiles.push({ path: subPath, data: utf8Encode(vttText) });
    }
  }

  for (const [mergedPath, mergedVtt] of Object.entries(compiled.mergedSubtitlesVtt)) {
    rawFiles.push({ path: mergedPath, data: utf8Encode(mergedVtt) });
  }

  const entries = prepareArchiveEntries(rawFiles, { storePaths: audioPaths });
  const zipBytes = await packPgnaZip(entries);

  return {
    zipBytes,
    entries,
    timeline: compiled.timeline,
    mergedSubtitlesVtt: compiled.mergedSubtitlesVtt,
    diagnostics: compiled.diagnostics,
  };
}

/**
 * Unpacks a `.pgna` ZIP archive into decoded manifest, PGN text, compiled timeline,
 * audio buffers, and WebVTT subtitle texts.
 */
export async function unpackPgnaArchive(zipBytes: Uint8Array): Promise<UnpackedPgnaArchive> {
  const entries = await unpackPgnaZip(zipBytes);
  const byPath = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    if (!isOsMetadataPath(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }

  const manifestEntry = byPath.get("manifest.json");
  if (!manifestEntry) {
    throw new Error('PGNA archive is missing required "manifest.json".');
  }
  const manifest = JSON.parse(utf8Decode(manifestEntry.data)) as PgnaManifest;

  const pgnEntry = byPath.get(manifest.pgnPath);
  if (!pgnEntry) {
    throw new Error(`PGNA archive is missing required PGN entry "${manifest.pgnPath}".`);
  }
  const pgnText = utf8Decode(pgnEntry.data);

  const timelineEntry = byPath.get(manifest.timelinePath);
  if (!timelineEntry) {
    throw new Error(`PGNA archive is missing required timeline entry "${manifest.timelinePath}".`);
  }
  const timeline = JSON.parse(utf8Decode(timelineEntry.data)) as PgnaTimeline;

  const audioPathSet = new Set<string>(Object.values(manifest.clips ?? {}).map((c) => c.path));
  const subtitlePathSet = new Set<string>();
  for (const clip of Object.values(manifest.clips ?? {})) {
    if (clip.subtitles) {
      for (const sp of Object.values(clip.subtitles)) {
        subtitlePathSet.add(sp);
      }
    }
  }

  const audioByPath: Record<string, Uint8Array> = {};
  const subtitlesByPath: Record<string, string> = {};

  for (const [entryPath, entry] of byPath.entries()) {
    if (audioPathSet.has(entryPath)) {
      audioByPath[entryPath] = entry.data;
    } else if (subtitlePathSet.has(entryPath) || entryPath.endsWith(".vtt")) {
      subtitlesByPath[entryPath] = utf8Decode(entry.data);
    }
  }

  return {
    entries,
    manifest,
    pgnText,
    timeline,
    audioByPath,
    subtitlesByPath,
  };
}
