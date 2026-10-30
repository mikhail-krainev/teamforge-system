import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { checkLink, itemErrorText } from './errors';

function api(
  status: number,
  code: string,
  errors?: { pointer: string; code?: string; message: string }[],
) {
  return new ApiError({
    status,
    body: undefined,
    problem: {
      type: 'x',
      title: 'x',
      status,
      code: code as never,
      requestId: 'r',
      ...(errors ? { errors } : {}),
    },
  });
}

describe('FR-WORK-04, SEC-05: links', () => {
  it('accepts https and names the problem of anything else', () => {
    expect(checkLink(' https://example.org/a ')).toBe('ok');
    expect(checkLink('http://127.0.0.1')).toBe('notHttps');
    expect(checkLink('javascript:alert(1)')).toBe('notHttps');
    expect(checkLink('not a url')).toBe('invalid');
    expect(checkLink('   ')).toBe('empty');
  });

  it('explains LINK_REJECTED as text, with the reason code when the server sends one', () => {
    expect(itemErrorText(api(422, 'LINK_REJECTED'))).toMatch(/Ссылка не подходит/);
    const withReason = api(422, 'LINK_REJECTED', [
      { pointer: '/linkUrl', code: 'BLOCKED_ADDRESS', message: 'x' },
    ]);
    expect(itemErrorText(withReason)).toMatch(/внутренний адрес/);
  });

  it('has own texts for ritual and review refusals and never shows the raw server detail', () => {
    expect(itemErrorText(api(422, 'RITUAL_FIELDS_REQUIRED'))).toMatch(
      /дату, ссылку на созвон и итоги/,
    );
    expect(itemErrorText(api(403, 'REVIEW_OWN_ITEM'))).toMatch(/Свой пункт проверять нельзя/);
    expect(itemErrorText(api(409, 'SOMETHING_NEW'))).toBe(
      'Не получилось сохранить пункт. Попробуй ещё раз.',
    );
  });
});
