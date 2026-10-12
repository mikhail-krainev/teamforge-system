import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { multipartBody } from '../../../test/fixtures/clients.js';
import { parseMultipart, uploadedFiles } from './multipart.js';

const file = (data: Buffer, field = 'file') => ({
  filename: 'cv.pdf',
  contentType: 'application/pdf',
  data,
  field,
});

describe('parseMultipart', () => {
  it('exposes the hash and size of the file, keeps the bytes out of the enumerable body', () => {
    const data = Buffer.from('%PDF-1.4 some bytes\r\nwith a line break');
    const { payload, contentType } = multipartBody(file(data));
    const body = parseMultipart(payload, contentType);
    expect(body).not.toBeNull();
    expect(body?.files.file).toEqual({
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.length,
    });
    expect(JSON.stringify(body)).not.toContain('some bytes');
    expect(uploadedFiles(body).get('file')?.bytes.equals(data)).toBe(true);
  });

  it('the same file in two requests gives the same body although the boundary differs', () => {
    const data = Buffer.from('%PDF-1.4 same');
    const [a, b] = [multipartBody(file(data)), multipartBody(file(data))];
    expect(a.contentType).not.toBe(b.contentType);
    expect(parseMultipart(a.payload, a.contentType)).toEqual(
      parseMultipart(b.payload, b.contentType),
    );
  });

  it('a body that is not multipart is refused', () => {
    expect(parseMultipart(Buffer.from('{"file":1}'), 'multipart/form-data; boundary=x')).toBeNull();
    expect(parseMultipart(Buffer.from('x'), 'multipart/form-data')).toBeNull();
  });
});
