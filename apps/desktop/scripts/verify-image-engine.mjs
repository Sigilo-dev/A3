import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(join(desktop, 'package.json'));
const lock = JSON.parse(await readFile(join(desktop, 'resources/image/toolchain.lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('Image conversion is unavailable outside the validated Windows x64 profile.');
} else {
  const sharp = require('sharp'), nativeManifest = require.resolve('@img/sharp-win32-x64/package');
  const native = JSON.parse(await readFile(nativeManifest, 'utf8'));
  assert.equal(sharp.versions.sharp, lock.sharp.version); assert.equal(sharp.versions.vips, lock.sharp.vips);
  assert.equal(native.version, lock.native.version); assert.equal(native.license, lock.native.license);
  for (const [file, expected] of Object.entries(lock.native.files)) {
    assert.equal(createHash('sha256').update(await readFile(join(dirname(nativeManifest), 'lib', file))).digest('hex'), expected, `Image artifact mismatch: ${file}`);
  }
  const packageLock = JSON.parse(await readFile(join(desktop, '../../package-lock.json'), 'utf8'));
  assert.equal(packageLock.packages['node_modules/sharp'].integrity, lock.sharp.integrity);
  assert.equal(packageLock.packages['node_modules/@img/sharp-win32-x64'].integrity, lock.native.integrity);
  assert.equal(packageLock.packages['node_modules/pdf-lib'].integrity, lock.pdfLib.integrity);
  if (process.argv.includes('--packaged')) {
    const packaged = join(desktop, 'dist/win-unpacked');
    for (const [file, expected] of Object.entries(lock.native.files)) {
      assert.equal(createHash('sha256').update(await readFile(join(packaged, 'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib', file))).digest('hex'), expected);
    }
    for (const file of ['LICENSE.sharp.txt', 'LICENSE.sharp-native.txt', 'LICENSE.pdf-lib.txt', 'LICENSE.lgpl-3.0.txt', 'LICENSE.gpl-3.0.txt', 'THIRD-PARTY-NOTICES.libvips.md']) {
      assert.ok((await readFile(join(packaged, 'licenses/image-conversion', file))).length > 0);
    }
    console.log('Packaged addon/DLL hashes and image license files verified.');
  }
  console.log(`Verified Sharp ${lock.sharp.version} / libvips ${lock.sharp.vips}, Windows x64 addon + DLL hashes, PDF-lib ${lock.pdfLib.version}.`);
}
