import { describe, expect, it } from 'vitest';
import { assertPlainText } from './plain-text.js';

const LIMITS = { min: 3, max: 10 };

const codeOf = (text: string): string | undefined => {
  try {
    assertPlainText(text, LIMITS, '/text');
    return undefined;
  } catch (error) {
    return (error as { data?: { errors?: { code: string }[] } }).data?.errors?.[0]?.code;
  }
};

describe('assertPlainText', () => {
  it('accepts text with tab, line feed and carriage return, and markup as written', () => {
    expect(codeOf('a\tb\r\nc')).toBeUndefined();
    expect(codeOf('<b>&amp;</b>')).toBe('length');
    expect(codeOf('<b>x</b>')).toBeUndefined();
  });

  it('refuses NUL, C0, DEL and C1 controls', () => {
    for (const control of ['\u0000', '\u0007', '\u007f', '\u0080', '\u009f']) {
      expect(codeOf(`abc${control}`)).toBe('control_characters');
    }
  });

  it('S7SEC-08: refuses bidi embeddings, overrides and isolates', () => {
    for (const control of ['‪', '‮', '⁦', '⁩']) {
      expect(codeOf(`abc${control}`)).toBe('control_characters');
    }
  });

  it('counts code points: spaces only are empty, an emoji is one character', () => {
    expect(codeOf('    ')).toBe('length');
    expect(codeOf('😀😀😀')).toBeUndefined();
    expect(codeOf('😀'.repeat(11))).toBe('length');
  });
});
