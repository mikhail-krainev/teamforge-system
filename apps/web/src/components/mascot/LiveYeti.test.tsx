// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveYeti } from './LiveYeti';
import { BUBBLE_HOLD_MS } from './useBubbleLine';

const LABEL = /Толик\. Нажми, чтобы поиграть/;

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LiveYeti', () => {
  it('renders a labelled button that starts idle', () => {
    render(<LiveYeti />);
    expect(screen.getByRole('button', { name: LABEL }).dataset.reaction).toBe('idle');
  });

  it('plays a different reaction on each click and dizzies after rapid clicks', () => {
    render(<LiveYeti />);
    const button = screen.getByRole('button', { name: LABEL });
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(button);
      seen.add(button.dataset.reaction ?? '');
    }
    expect(seen.size).toBe(4);
    expect(seen.has('idle')).toBe(false);
    fireEvent.click(button);
    expect(button.dataset.reaction).toBe('dizzy');
  });

  it('swaps pose without confetti under reduced motion', () => {
    mockReducedMotion(true);
    const { container } = render(<LiveYeti />);
    const button = screen.getByRole('button', { name: LABEL });
    for (let i = 0; i < 5; i += 1) {
      expect(() => fireEvent.click(button)).not.toThrow();
    }
    expect(container.querySelector('.live-yeti-confetti')).toBeNull();
  });

  it('shows a reaction line in the bubble, then brings the greeting back', () => {
    vi.useFakeTimers();
    render(<LiveYeti greeting="Привет! Я Толик" />);
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.queryByText('Привет! Я Толик')).toBeNull();
    act(() => vi.advanceTimersByTime(BUBBLE_HOLD_MS));
    expect(screen.getByText('Привет! Я Толик')).toBeTruthy();
  });
});
