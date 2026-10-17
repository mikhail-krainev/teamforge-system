import { describe, expect, it } from 'vitest';
import { parsePlaybooksLoadArgs } from './playbooks-load-args.js';

describe('parsePlaybooksLoadArgs (playbooks:load, FR-PLAY-05)', () => {
  it('takes one file', () => {
    expect(parsePlaybooksLoadArgs(['seeds/playbooks/web_service.yaml'])).toEqual({
      ok: true,
      files: ['seeds/playbooks/web_service.yaml'],
      publish: false,
    });
  });

  it('takes several files and --publish in any position', () => {
    expect(parsePlaybooksLoadArgs(['--publish', 'a.yaml', 'b.yaml'])).toEqual({
      ok: true,
      files: ['a.yaml', 'b.yaml'],
      publish: true,
    });
    expect(parsePlaybooksLoadArgs(['a.yaml', '--publish'])).toMatchObject({ publish: true });
  });

  it.each([[[]], [['--publish']], [['']], [['a.yaml', '--force']], [['-p', 'a.yaml']]])(
    'refuses %j before anything is connected',
    (argv) => {
      const result = parsePlaybooksLoadArgs(argv);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('usage: playbooks:load');
    },
  );
});
