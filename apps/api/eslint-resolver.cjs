// Minimal import resolver for eslint-plugin-boundaries: maps NodeNext-style relative imports
// ("./x.js") to the TypeScript source files that exist on disk. Bare specifiers are left to the
// plugin (it classifies them as external).
const { existsSync, statSync } = require('node:fs');
const path = require('node:path');

exports.interfaceVersion = 2;

function isFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
}

exports.resolve = (source, file) => {
  if (!source.startsWith('.')) return { found: false };
  const base = path.resolve(path.dirname(file), source);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ];
  const hit = candidates.find(isFile);
  return hit ? { found: true, path: hit } : { found: false };
};
