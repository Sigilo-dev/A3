'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const tempRoot = path.resolve(process.argv[2] || '');
const tempBase = path.resolve(require('node:os').tmpdir());
const grantedRoot = path.join(tempRoot, 'granted');
const outsideRoot = path.join(tempRoot, 'ungranted');
const markerPath = path.join(outsideRoot, 'sentinel.json');
const marker = 'a3-e0-c2 synthetic sentinel';

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

if (!path.basename(tempRoot).startsWith('a3-e0-c2-') || !isWithin(tempBase, tempRoot) || !isWithin(tempRoot, grantedRoot) || !isWithin(tempRoot, outsideRoot)) {
  process.stderr.write('refusing to run outside the marked temporary fixture\n');
  process.exit(70);
}
if (process.cwd() !== tempRoot || fs.readFileSync(markerPath, 'utf8') !== marker) {
  process.stderr.write('temporary fixture marker or working directory mismatch\n');
  process.exit(71);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ error: 'invalid-json' })}\n`);
    return;
  }

  if (message.command === 'shutdown') {
    process.stdout.write(`${JSON.stringify({ stopped: true })}\n`, () => process.exit(0));
    return;
  }

  if (message.command !== 'raw-probe') {
    process.stdout.write(`${JSON.stringify({ error: 'unknown-command' })}\n`);
    return;
  }

  // Deliberately bypasses the test host's logical path/capability checks. Every
  // resolved target is still confined to this runner's disposable temp root.
  const traversalRead = path.resolve(grantedRoot, '..', 'ungranted', 'sentinel.json');
  const traversalWrite = path.resolve(grantedRoot, '..', 'ungranted', 'child-created.json');
  const junctionRead = path.join(grantedRoot, 'junction-out', 'sentinel.json');
  const junctionWrite = path.join(grantedRoot, 'junction-out', 'child-junction-created.json');

  if (![traversalRead, traversalWrite, junctionRead, junctionWrite].every((target) => isWithin(tempRoot, path.resolve(target)))) {
    process.stdout.write(`${JSON.stringify({ error: 'fixture-target-outside-temp-root' })}\n`);
    return;
  }

  let traversalReadSucceeded = false;
  let junctionReadSucceeded = false;
  try { traversalReadSucceeded = fs.readFileSync(traversalRead, 'utf8') === marker; } catch { /* result is reported below */ }
  try { junctionReadSucceeded = fs.readFileSync(junctionRead, 'utf8') === marker; } catch { /* junction can be unavailable */ }
  fs.writeFileSync(traversalWrite, 'child write inside disposable ungranted fixture\n', { encoding: 'utf8', flag: 'w' });
  let junctionWriteSucceeded = false;
  try {
    fs.writeFileSync(junctionWrite, 'child junction write inside disposable fixture\n', { encoding: 'utf8', flag: 'w' });
    junctionWriteSucceeded = true;
  } catch { /* junction can be unavailable */ }

  process.stdout.write(`${JSON.stringify({
    traversalReadSucceeded,
    traversalWriteSucceeded: fs.existsSync(traversalWrite),
    junctionReadSucceeded,
    junctionWriteSucceeded
  })}\n`);
});
