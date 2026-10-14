import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function licenseText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.type === 'string') return value.type;
  return '';
}

test('all direct spike dependencies are pinned and declare an allowed license', (t) => {
  for (const [name, expectedVersion] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const packagePath = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    assert.ok(fs.existsSync(packagePath), `${name} is installed`);
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const declared = licenseText(pkg.license);
    assert.equal(pkg.version, expectedVersion, `${name} exact package version`);
    assert.match(declared, /^(MIT|Apache-2\.0|BSD-\d-Clause|ISC)$/i, `${name} declared license ${declared}`);
    t.diagnostic(`${name}@${pkg.version}: ${declared}`);
  }
});
