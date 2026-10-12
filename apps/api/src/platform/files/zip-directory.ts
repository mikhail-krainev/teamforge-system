/** One entry of a ZIP central directory. */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - EOCD_MIN - MAX_COMMENT);
  for (let at = zip.length - EOCD_MIN; at >= lowest; at -= 1) {
    if (zip.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

/**
 * Lists the entries from the central directory without inflating anything (architecture 13.7).
 * Returns null when the directory is missing or inconsistent; a ZIP64 archive counts as unreadable
 * (a resume has no use for it).
 */
export function readZipDirectory(zip: Buffer): ZipEntry[] | null {
  const eocd = findEndOfCentralDirectory(zip);
  if (eocd === -1) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    if (at + 46 + nameLength > zip.length) return null;
    entries.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      compressedSize: zip.readUInt32LE(at + 20),
      uncompressedSize: zip.readUInt32LE(at + 24),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** ZIP limits of architecture 13.7 / C-25: total expanded size, entry count, compression ratio. */
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_RATIO = 100;

/** True when the archive would expand into too much (a zip bomb) or has too many entries. */
export function zipLimitsExceeded(entries: readonly ZipEntry[]): boolean {
  const expanded = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const compressed = entries.reduce((sum, entry) => sum + entry.compressedSize, 0);
  return (
    entries.length > MAX_ENTRIES ||
    expanded > MAX_EXPANDED_BYTES ||
    expanded > Math.max(compressed, 1) * MAX_RATIO
  );
}
