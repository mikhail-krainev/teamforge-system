import base from './playwright.config';

// Local only (not committed): the browser cache holds chromium 1243, this Playwright wants 1248.
export default {
  ...base,
  projects: base.projects?.map((p) => ({
    ...p,
    use: {
      ...p.use,
      launchOptions: {
        executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
      },
    },
  })),
};
