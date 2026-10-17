import { describe, expect, it } from 'vitest';
import { checkArtifactFile, formatFileSize, MAX_FILE_BYTES, MIN_FILE_BYTES } from './validate';

const file = (name: string, size: number) => ({ name, size });

describe('FR-WORK-05: client pre-check of an artifact file', () => {
  it('accepts allowed formats inside the size window, in any letter case', () => {
    expect(checkArtifactFile(file('Spec.PDF', 5000))).toBe('ok');
    expect(checkArtifactFile(file('a.zip', MIN_FILE_BYTES))).toBe('ok');
    expect(checkArtifactFile(file('a.md', MAX_FILE_BYTES))).toBe('ok');
  });

  it('refuses a type outside the list, including executables', () => {
    for (const name of ['run.exe', 'script.sh', 'archive.tar.gz', 'noextension']) {
      expect(checkArtifactFile(file(name, 5000))).toBe('wrongType');
    }
  });

  it('refuses files below 1 KiB and above 10 MiB', () => {
    expect(checkArtifactFile(file('a.pdf', MIN_FILE_BYTES - 1))).toBe('tooSmall');
    expect(checkArtifactFile(file('a.pdf', MAX_FILE_BYTES + 1))).toBe('tooLarge');
  });

  it('formats sizes in KB and MB', () => {
    expect(formatFileSize(1500)).toBe('1 КБ');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3,0 МБ');
  });
});
