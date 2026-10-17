import { randomUUID } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import type { UploadFile } from './clients.js';
import { resumeBytes } from './profiles.js';

/**
 * Artifact files of the slice 5 tests (FR-WORK-05): small, valid by magic bytes, and unique per call
 * (the nonce makes the SHA-256 differ, so `sha_dedup` signals never depend on test order).
 * Allowed formats: pdf, png, jpg, webp, md, txt, docx, pptx, zip; 1 KiB .. 10 MiB.
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;
/** C-47 is "10 МБ"; one byte over it is over in both readings (MB and MiB). */
export const OVER_MAX_BYTES = 10 * MIB + 1;
/** Quota of a project (C-48, C-49). */
export const PROJECT_MAX_FILES = 30;
export const PROJECT_MAX_BYTES = 50 * MIB;

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  md: 'text/markdown',
  txt: 'text/plain',
  zip: 'application/zip',
  exe: 'application/octet-stream',
} as const;

const nonce = (): string => randomUUID();

/** Pads a buffer with a comment tail to `size` bytes; the tail carries the nonce. */
function padded(head: Buffer, size: number, fill: string): Buffer {
  const tail = Buffer.from(`\n% ${nonce()}\n`);
  const room = Math.max(size - head.length - tail.length, 0);
  return Buffer.concat([head, tail, Buffer.alloc(room, fill)]);
}

/** A PDF (the resume fixture, 741 bytes, plus a unique comment tail) of at least `size` bytes. */
export function pdfFile(options: { size?: number; name?: string } = {}): UploadFile {
  return {
    filename: options.name ?? 'artifact.pdf',
    contentType: MIME.pdf,
    data: padded(resumeBytes('resume.pdf'), options.size ?? 2 * KIB, ' '),
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid 1x1 PNG with a `tEXt` chunk that pads it to `size` bytes. */
export function pngFile(options: { size?: number; name?: string } = {}): UploadFile {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const idat = Buffer.from([
    0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00,
  ]);
  const textLength = Math.max((options.size ?? 2 * KIB) - 120, 64);
  const text = Buffer.from(`Comment\0${nonce()} ${'x'.repeat(textLength)}`);
  return {
    filename: options.name ?? 'screen.png',
    contentType: MIME.png,
    data: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('tEXt', text),
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

/** A JPEG skeleton (SOI, APP0, a COM segment that pads it, EOI): the signature is what is checked. */
export function jpegFile(options: { size?: number; name?: string } = {}): UploadFile {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const comment = Buffer.from(
    `${nonce()} ${'j'.repeat(Math.max((options.size ?? 2 * KIB) - 80, 16))}`,
  );
  const com = Buffer.concat([
    Buffer.from([0xff, 0xfe, (comment.length + 2) >> 8, (comment.length + 2) & 0xff]),
    comment,
  ]);
  return {
    filename: options.name ?? 'photo.jpg',
    contentType: MIME.jpg,
    data: Buffer.concat([Buffer.from([0xff, 0xd8]), app0, com, Buffer.from([0xff, 0xd9])]),
  };
}

const markdown = (size: number): string => {
  const head = `# Артефакт ${nonce()}\n\n## Цель\n\n## Решение\n\n## Альтернативы\n\n`;
  return head + 'Текст раздела.\n'.repeat(Math.ceil(Math.max(size - head.length, 0) / 15));
};

export function mdFile(options: { size?: number; name?: string } = {}): UploadFile {
  return {
    filename: options.name ?? 'design.md',
    contentType: MIME.md,
    data: Buffer.from(markdown(options.size ?? 2 * KIB)),
  };
}

export function txtFile(options: { size?: number; name?: string } = {}): UploadFile {
  return {
    filename: options.name ?? 'notes.txt',
    contentType: MIME.txt,
    data: Buffer.from(markdown(options.size ?? 2 * KIB).replaceAll('#', '')),
  };
}

/** A real ZIP archive (one deflated entry) of the given payload size. */
export function zipFile(options: { name?: string; entries?: number } = {}): UploadFile {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < (options.entries ?? 1); i += 1) {
    const name = Buffer.from(`file-${i}.txt`);
    const raw = Buffer.from(`${nonce()}\n${'содержимое архива\n'.repeat(120)}`);
    const packed = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.concat([local, name, packed]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    parts.push(entry);
    offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return {
    filename: options.name ?? 'bundle.zip',
    contentType: MIME.zip,
    data: Buffer.concat([...parts, directory, end]),
  };
}

/** A Windows executable (MZ header) behind an innocent name and content type (FR-WORK-05: executables are refused). */
export function exeFile(options: { name?: string; contentType?: string } = {}): UploadFile {
  return {
    filename: options.name ?? 'report.pdf',
    contentType: options.contentType ?? MIME.pdf,
    data: padded(
      Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00', 'latin1'),
      2 * KIB,
      'A',
    ),
  };
}

/** A PDF shorter than 1 KiB (FILE_TOO_SMALL). */
export function tinyFile(): UploadFile {
  return {
    filename: 'tiny.pdf',
    contentType: MIME.pdf,
    data: resumeBytes('resume.pdf').subarray(0, 512),
  };
}

/** A PDF over the limit of a file: `OVER_MAX_BYTES` by default (FILE_TOO_LARGE). */
export function hugeFile(size: number = OVER_MAX_BYTES): UploadFile {
  const head = resumeBytes('resume.pdf');
  return {
    filename: 'huge.pdf',
    contentType: MIME.pdf,
    data: Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]),
  };
}

/** Plain text that claims to be a PDF: the type comes from the magic bytes, not from the name (FR-WORK-05). */
export function renamedTextFile(): UploadFile {
  return { filename: 'fake.pdf', contentType: MIME.pdf, data: Buffer.from(markdown(2 * KIB)) };
}

/** Every allowed format once, as `[format, builder]` for `it.each`. */
export const ALLOWED_FORMATS: [string, () => UploadFile][] = [
  ['pdf', () => pdfFile()],
  ['png', () => pngFile()],
  ['jpg', () => jpegFile()],
  ['md', () => mdFile()],
  ['txt', () => txtFile()],
  ['zip', () => zipFile()],
];
