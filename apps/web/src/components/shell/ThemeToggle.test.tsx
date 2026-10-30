// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTheme } from './theme';
import { ThemeToggle } from './ThemeToggle';

function mockSystemDark(isDark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: isDark, media: query }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.cookie = 'theme=; path=/; max-age=0';
});

describe('ThemeToggle', () => {
  it('switches a light system theme to dark and remembers it', () => {
    mockSystemDark(false);
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Сменить тему' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.cookie).toContain('theme=dark');
  });

  it('flips a forced theme back', () => {
    mockSystemDark(true);
    document.documentElement.dataset.theme = 'light';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Сменить тему' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('parseTheme', () => {
  it('accepts only light and dark', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('blue')).toBeUndefined();
    expect(parseTheme(undefined)).toBeUndefined();
  });
});
