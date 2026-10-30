// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { renderWithClient, sampleUpload } from '@/test/support';
import { uploadResume } from './api';
import { UploadForm } from './UploadForm';

// The multipart transport is the client's job; here the form's decisions are under test.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  uploadResume: vi.fn(),
}));
const upload = vi.mocked(uploadResume);

beforeEach(() => upload.mockReset());
afterEach(cleanup);

const pick = (file: File) =>
  fireEvent.change(screen.getByLabelText(/Файл резюме/), { target: { files: [file] } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Загрузить' }));
const pdf = (name = 'cv.pdf', size = 10) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' });

describe('UploadForm', () => {
  it('asks for a file before sending anything', () => {
    renderWithClient(<UploadForm onUploaded={vi.fn()} />);
    submit();
    expect(screen.getByText('Выбери файл.')).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong extension', pdf('cv.txt'), 'Подходит только PDF или DOCX.'],
    ['a file over 5 MB', pdf('cv.pdf', 5 * 1024 * 1024 + 1), 'Файл больше 5 МБ.'],
  ])('rejects %s locally', (_name, file, message) => {
    renderWithClient(<UploadForm onUploaded={vi.fn()} />);
    pick(file);
    submit();
    expect(screen.getByText(message)).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it('sends the file with an idempotency key and reports the upload', async () => {
    upload.mockResolvedValue(sampleUpload({ status: 'queued' }));
    const onUploaded = vi.fn();
    renderWithClient(<UploadForm onUploaded={onUploaded} />);
    const file = pdf();
    pick(file);
    submit();
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(upload.mock.calls[0]?.[0]).toBe(file);
    expect(upload.mock.calls[0]?.[1]).toBeTruthy();
  });

  it('keeps the key for the same file after a 503 and takes a new one for another file', async () => {
    const unavailable = () => Promise.reject(new ApiError({ status: 503, body: undefined }));
    upload.mockImplementationOnce(unavailable);
    upload.mockImplementationOnce(unavailable);
    upload.mockResolvedValue(sampleUpload({ status: 'queued' }));
    renderWithClient(<UploadForm onUploaded={vi.fn()} />);
    pick(pdf('a.pdf', 10));
    submit();
    await screen.findByRole('alert');
    submit();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    pick(pdf('b.pdf', 20));
    submit();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    const keys = upload.mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
