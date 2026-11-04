/**
 * A small ZIP reader using only Web APIs (DataView, TextDecoder, DecompressionStream), so the same
 * code runs in the Worker and in the browser. Supports stored (0) and deflate (8) entries, which
 * is what Plausible's CSV export produces. ZIP64 archives are rejected with a clear error.
 *
 * Format reference: PKWARE APPNOTE.TXT, sections 4.3.7 (local file header), 4.3.12 (central
 * directory header) and 4.3.16 (end of central directory record).
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  method: number;
  read(): Promise<Uint8Array>;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new ZipError("This runtime cannot decompress ZIP files (DecompressionStream is missing)");
  }
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function readZip(bytes: Uint8Array, maxEntries = 200): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a ZIP file (no end of central directory record)");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipError("ZIP64 archives are not supported");
  if (cdOffset + cdSize > bytes.length)
    throw new ZipError("Corrupt ZIP file (central directory out of range)");
  if (count > maxEntries) throw new ZipError(`ZIP file has too many entries (${count})`);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) {
      throw new ZipError("Corrupt ZIP file (bad central directory entry)");
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (compressedSize === 0xffffffff || size === 0xffffffff)
      throw new ZipError("ZIP64 archives are not supported");
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      compressedSize,
      size,
      method,
      async read() {
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL) {
          throw new ZipError(`Corrupt ZIP file (bad local header for ${name})`);
        }
        const start =
          localOffset +
          30 +
          view.getUint16(localOffset + 26, true) +
          view.getUint16(localOffset + 28, true);
        const data = bytes.subarray(start, start + compressedSize);
        if (method === 0) return data;
        if (method === 8) {
          const out = await inflateRaw(data);
          if (out.length !== size) throw new ZipError(`Corrupt ZIP entry ${name} (size mismatch)`);
          return out;
        }
        throw new ZipError(`Unsupported ZIP compression method ${method} in ${name}`);
      },
    });
  }
  return entries;
}
