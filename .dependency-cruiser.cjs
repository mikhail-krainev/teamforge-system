/**
 * Module boundaries of apps/api (docs/architecture.md 2.1-2.2, ADR-0001).
 *
 * MODULE_EDGES (non-enumerable export) is the allowed graph of synchronous calls: "A -> B" means A may import
 * `modules/B/public.ts`. It is shared with eslint.config.js (eslint-plugin-boundaries), which
 * reads it from this file, so the two checks cannot drift apart.
 *
 * Run: `pnpm --filter api run depcruise` (paths are matched with or without an `apps/api/` prefix).
 */
const MODULE_EDGES = {
  auth: [],
  profiles: ['auth'],
  playbooks: ['profiles'],
  teams: ['auth', 'profiles', 'playbooks'],
  matching: ['teams', 'profiles', 'auth'],
  github: ['teams', 'auth'],
  workspace: ['teams', 'playbooks', 'github', 'profiles', 'auth'],
  rewards: ['teams', 'workspace', 'github', 'playbooks', 'auth'],
};

const SRC = '(^|/)src/';
const MODULES_DIR = `${SRC}modules/`;

/** For each module: it may import only itself and the public.ts of its allowed targets. */
const edgeRules = Object.entries(MODULE_EDGES).map(([name, allowed]) => ({
  name: `module-edge-${name}`,
  severity: 'error',
  comment: `${name} may depend only on: ${allowed.join(', ') || 'nothing'} (architecture 2.2)`,
  from: { path: `${MODULES_DIR}${name}/` },
  to: {
    path: `${MODULES_DIR}[^/]+/`,
    pathNot: `${MODULES_DIR}(${[name, ...allowed].join('|')})/`,
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Dependency cycles are forbidden (architecture 2.2).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-cross-module-internal',
      severity: 'error',
      comment:
        'Another module may import only modules/<m>/public.ts, never internal/**, test/** or <m>.module.ts.',
      from: { path: `${MODULES_DIR}([^/]+)/` },
      to: {
        path: `${MODULES_DIR}([^/]+)/(internal/|test/|[^/]+\\.module\\.ts$)`,
        pathNot: `${MODULES_DIR}$2/`,
      },
    },
    ...edgeRules,
    {
      name: 'platform-not-to-modules',
      severity: 'error',
      comment: 'The platform layer sits below the modules and must not import them.',
      from: { path: `${SRC}platform/` },
      to: { path: MODULES_DIR },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};

// depcruise rejects unknown keys, so the shared table is exposed as a non-enumerable property.
Object.defineProperty(config, 'MODULE_EDGES', { value: MODULE_EDGES, enumerable: false });

module.exports = config;
