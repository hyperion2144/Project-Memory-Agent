/**
 * Packaged-manifest invariants — host core packages must never be installed.
 *
 * DSH installs profile plugins with a HOISTED node_modules. A host core package
 * declared under `dependencies` therefore lands in the profile root, where it is
 * nearer than DSH's own shared core layer on the module-resolution chain and
 * SHADOWS it. The host's typert loader resolves every entry's package from that
 * tree, so it registers the stale copy's `./typert` manifest, fails strict codec
 * validation, and takes the whole `@deepseek-ai/dsh-llm` entry down with it —
 * `dsh: warning: 1 entry did not activate`, `GET /api/llm/listProviders` 404,
 * and no session can load. See Project-Memory-Agent issue #1.
 *
 * Core packages are therefore only ever declared as peers: DSH resolves them
 * from its own shared layer, and its version gate reads `peerDependencies`
 * alone (a peer range that the running dsh fails to satisfy blocks install).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

/** Host core packages: the umbrella `@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*`. */
function isHostCore(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
}

/** Every `@deepseek-ai/*` specifier imported by shipped (non-test) code. */
function shippedCoreImports() {
  const found = new Map();
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"](@deepseek-ai\/[^'"]+)['"]/g;
  for (const dir of ['dsh', 'src', 'bin']) {
    const root = path.join(pkgRoot, dir);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      const parent = entry.parentPath || entry.path || root;
      const file = path.join(parent, entry.name);
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(pattern)) {
        if (!found.has(match[1])) found.set(match[1], path.relative(pkgRoot, file));
      }
    }
  }
  return found;
}

test('manifest: no host core package is a runtime dependency', () => {
  const offenders = Object.keys(manifest.dependencies ?? {}).filter(isHostCore);
  assert.deepEqual(
    offenders,
    [],
    `host core packages must be peerDependencies, never dependencies — a hoisted copy shadows the host's own: ${offenders.join(', ')}`,
  );
});

test('manifest: every host core import in shipped code is declared as a peer', () => {
  const declared = new Set(Object.keys(manifest.peerDependencies ?? {}));
  const undeclared = [...shippedCoreImports()]
    .filter(([specifier]) => !declared.has(specifier))
    .map(([specifier, file]) => `${specifier} (imported by ${file})`);
  assert.deepEqual(undeclared, [], `host core imports missing from peerDependencies: ${undeclared.join(', ')}`);
});

test('manifest: host core peers move together with the declared dsh compatibility', () => {
  const compatibility = manifest.dsh?.compatibility ?? {};
  const floor = compatibility.dshVersions;
  assert.equal(typeof floor, 'string', 'dsh.compatibility.dshVersions must declare the supported range');

  const approved = Object.keys(compatibility.dshReleases ?? {});
  assert.ok(approved.length > 0, 'dsh.compatibility.dshReleases must approve at least one exact release');
  for (const release of approved) {
    assert.match(release, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `approved release "${release}" must be an exact version`);
  }

  const drifted = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => isHostCore(name))
    .filter(([, range]) => range !== floor)
    .map(([name, range]) => `${name}: ${range} != ${floor}`);
  assert.deepEqual(drifted, [], `host core peer ranges must match dsh.compatibility.dshVersions: ${drifted.join(', ')}`);
});
