import { compose } from './stack';

/** Removes the `e2e` compose project with its volumes, unless E2E_KEEP_STACK=1. */
export default function globalTeardown(): void {
  if (process.env.E2E_KEEP_STACK === '1') return;
  compose('down', '-v', '--remove-orphans');
}
