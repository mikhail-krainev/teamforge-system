// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPLY_HOLD_MS, YetiChat } from './YetiChat';

const QUESTION = 'Табы или пробелы?';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('YetiChat', () => {
  it('labels the input with the question and does not take focus', () => {
    render(<YetiChat questionKey="mascot.chat.question.tabs" onDone={vi.fn()} />);
    const input = screen.getByLabelText(QUESTION);
    expect(input.getAttribute('maxlength')).toBe('80');
    expect(document.activeElement).not.toBe(input);
  });

  it('shows the reply after submit and calls onDone after the hold time', () => {
    const onDone = vi.fn();
    render(<YetiChat questionKey="mascot.chat.question.tabs" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText(QUESTION), { target: { value: 'пробелы' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    expect(screen.getByText(/Пробелы\. Ровно/)).toBeTruthy();
    expect(screen.queryByLabelText(QUESTION)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(REPLY_HOLD_MS);
    });
    expect(onDone).toHaveBeenCalledExactlyOnceWith('happy');
  });

  it('closes with a neutral mood on Escape and on the close button', () => {
    const onDone = vi.fn();
    const { unmount } = render(
      <YetiChat questionKey="mascot.chat.question.tabs" onDone={onDone} />,
    );
    fireEvent.keyDown(screen.getByLabelText(QUESTION), { key: 'Escape' });
    expect(onDone).toHaveBeenCalledExactlyOnceWith('neutral');
    unmount();

    const onDoneClose = vi.fn();
    render(<YetiChat questionKey="mascot.chat.question.tabs" onDone={onDoneClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onDoneClose).toHaveBeenCalledExactlyOnceWith('neutral');
  });

  it('does not call onDone after unmount', () => {
    const onDone = vi.fn();
    const { unmount } = render(
      <YetiChat questionKey="mascot.chat.question.tabs" onDone={onDone} />,
    );
    fireEvent.submit(screen.getByLabelText(QUESTION).closest('form')!);
    unmount();
    act(() => {
      vi.advanceTimersByTime(REPLY_HOLD_MS * 2);
    });
    expect(onDone).not.toHaveBeenCalled();
  });
});
