import { t } from '@/i18n';

/** Formats of FR-WORK-05 (the server decides by magic bytes; this is a cheap pre-check). */
export const ALLOWED_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.md',
  '.txt',
  '.docx',
  '.pptx',
  '.zip',
] as const;
export const MIN_FILE_BYTES = 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_ACCEPT = ALLOWED_EXTENSIONS.join(',');

export type FileVerdict = 'ok' | 'wrongType' | 'tooLarge' | 'tooSmall';

export function checkArtifactFile(file: Pick<File, 'name' | 'size'>): FileVerdict {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'wrongType';
  if (file.size > MAX_FILE_BYTES) return 'tooLarge';
  return file.size < MIN_FILE_BYTES ? 'tooSmall' : 'ok';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024)
    return t('artifacts.sizeKb', { value: Math.max(1, Math.round(bytes / 1024)) });
  return t('artifacts.sizeMb', { value: (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') });
}
