'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const spikeDir = __dirname;
const workerPath = path.join(spikeDir, 'worker.cjs');
const tempBase = fs.realpathSync(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'a3-e0-c1-'));
const reports = [];
let failures = 0;

function record(name, expected, observed, pass, details = {}) {
  const report = { name, expected, observed, pass, ...details };
  reports.push(report);
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(report)}\n`);
  if (!pass) failures += 1;
}

function assertOwnTempRoot() {
  const resolved = path.resolve(tempRoot);
  const base = path.resolve(tempBase);
  if (!resolved.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`) || !path.basename(resolved).startsWith('a3-e0-c1-')) {
    throw new Error(`refusing to clean a path not created by this runner: ${resolved}`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFlushed(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function makeCase(caseName) {
  const caseRoot = path.join(tempRoot, caseName);
  const txRoot = path.join(caseRoot, '.a3', 'local', 'transactions', 'op-c1-0001');
  const documents = [
    {
      path: path.join('docs', 'notas-東京.json'),
      id: '40000000-0000-4000-8000-000000000001',
      titleBefore: 'Antes: café',
      titleAfter: 'Después: café',
      body: 'Contenido sintético: ñ, 東京, 🧪.'
    },
    {
      path: path.join('docs', 'resumen-niño.json'),
      id: '40000000-0000-4000-8000-000000000002',
      titleBefore: 'Resumen inicial',
      titleAfter: 'Resumen confirmado',
      body: 'Solo datos generados por este ensayo.'
    }
  ];

  fs.mkdirSync(path.join(caseRoot, 'docs'), { recursive: true });
  const files = documents.map((document, index) => {
    const before = jsonBytes({
      schemaVersion: '1.0.0',
      id: document.id,
      revision: 1,
      title: document.titleBefore,
      content: document.body
    });
    const after = jsonBytes({
      schemaVersion: '1.0.0',
      id: document.id,
      revision: 2,
      title: document.titleAfter,
      content: document.body
    });
    const fileName = path.basename(document.path);
    const target = path.join(caseRoot, document.path);
    const backupPath = path.join('.a3', 'local', 'transactions', 'op-c1-0001', 'backups', fileName);
    const stagedPath = path.join('.a3', 'local', 'transactions', 'op-c1-0001', 'staging', fileName);
    const restorePath = path.join('.a3', 'local', 'transactions', 'op-c1-0001', 'restore', fileName);
    writeFlushed(target, before);
    writeFlushed(path.join(caseRoot, backupPath), before);
    writeFlushed(path.join(caseRoot, stagedPath), after);
    return {
      path: document.path,
      revisionBefore: 1,
      revisionAfter: 2,
      beforeHash: sha256(before),
      afterHash: sha256(after),
      backupPath,
      stagedPath,
      restorePath
    };
  });

  const journalPath = path.join('.a3', 'local', 'transactions', 'op-c1-0001', 'journal.jsonl');
  const meta = { harnessMarker: 'a3-e0-c1-test-data', operationId: 'op-c1-0001', journalPath, files };
  writeFlushed(path.join(caseRoot, 'transaction.json'), jsonBytes(meta));
  writeFlushed(path.join(caseRoot, journalPath), Buffer.alloc(0));
  const fd = fs.openSync(path.join(caseRoot, journalPath), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify({ event: 'prepared', operationId: meta.operationId, files: files.map(({ path: filePath, revisionBefore, revisionAfter, beforeHash, afterHash }) => ({ path: filePath, revisionBefore, revisionAfter, beforeHash, afterHash })) })}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { caseRoot, meta, files };
}

function runWorker(mode, caseRoot, crashAt = '') {
  return spawnSync(process.execPath, [workerPath, mode, caseRoot, crashAt], {
    cwd: spikeDir,
    encoding: 'utf8',
    windowsHide: true
  });
}

function currentHashes(caseInfo) {
  return caseInfo.files.map((file) => sha256(fs.readFileSync(path.join(caseInfo.caseRoot, file.path))));
}

function testUtf8AndExistingFileReplacement() {
  const caseInfo = makeCase('utf8-and-replace');
  const target = path.join(caseInfo.caseRoot, caseInfo.files[0].path);
  const staged = path.join(caseInfo.caseRoot, caseInfo.files[0].stagedPath);
  const backup = path.join(caseInfo.caseRoot, caseInfo.files[0].backupPath);
  const journal = path.join(caseInfo.caseRoot, caseInfo.meta.journalPath);
  const originalBytes = fs.readFileSync(target);
  const volume = fs.statSync(caseInfo.caseRoot).dev;
  const sameVolume = [target, staged, backup, journal].every((artifact) => fs.statSync(artifact).dev === volume);
  assert.equal(sameVolume, true);
  const parsed = JSON.parse(originalBytes.toString('utf8'));
  assert.equal(parsed.title, 'Antes: café');
  assert.match(parsed.content, /東京/);
  assert.equal(originalBytes.at(-1), 0x0a);

  const result = runWorker('apply', caseInfo.caseRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(final.revision, 2);
  assert.equal(final.title, 'Después: café');
  record('utf8-json-and-replace-existing-destination', 'UTF-8 JSON, LF final, revision 1→2, existing destination replaced', 'passed; bytes decode and destination contains revision 2', true, {
    sameVolume,
    sha256Before: caseInfo.files[0].beforeHash,
    sha256After: sha256(fs.readFileSync(target))
  });
}

function testSyncApis() {
  const file = path.join(tempRoot, 'sync-probe.json');
  const fd = fs.openSync(file, 'w');
  let fsyncResult = 'not-run';
  let fdatasyncResult = 'not-run';
  try {
    fs.writeSync(fd, Buffer.from('{"sync":"prueba"}\n', 'utf8'));
    try { fs.fsyncSync(fd); fsyncResult = 'success'; } catch (error) { fsyncResult = error.code || error.message; }
    if (typeof fs.fdatasyncSync === 'function') {
      try { fs.fdatasyncSync(fd); fdatasyncResult = 'success'; } catch (error) { fdatasyncResult = error.code || error.message; }
    } else {
      fdatasyncResult = 'unavailable';
    }
  } finally {
    fs.closeSync(fd);
  }

  let directoryFsync = 'not-run';
  try {
    const dirFd = fs.openSync(tempRoot, 'r');
    try { fs.fsyncSync(dirFd); directoryFsync = 'success'; } finally { fs.closeSync(dirFd); }
  } catch (error) {
    directoryFsync = error.code || error.message;
  }

  assert.equal(fsyncResult, 'success');
  record('file-and-directory-sync-capability', 'file fsync succeeds; report fdatasync and directory fsync behavior', `fsync=${fsyncResult}; fdatasync=${fdatasyncResult}; directory-fsync=${directoryFsync}`, true, {
    hasFsyncSync: typeof fs.fsyncSync === 'function',
    hasFdatasyncSync: typeof fs.fdatasyncSync === 'function'
  });
}

function testExclusiveCreate() {
  const lockPath = path.join(tempRoot, 'writer.lock');
  const first = fs.openSync(lockPath, 'wx');
  let secondResult = 'unexpected-success';
  try {
    try {
      const second = fs.openSync(lockPath, 'wx');
      fs.closeSync(second);
    } catch (error) {
      secondResult = error.code || error.message;
    }
  } finally {
    fs.closeSync(first);
  }
  assert.equal(secondResult, 'EEXIST');
  record('exclusive-lockfile-create-collision', 'second open with wx fails while lock file exists', `second open returned ${secondResult}`, true, {
    limitation: 'exclusive-create lockfile only; not a kernel byte-range lock or stale-owner/liveness protocol'
  });
}

function testLongPath() {
  const segments = Array.from({ length: 7 }, (_, index) => `segment-${index}-${'ü'.repeat(28)}`);
  const target = path.join(tempRoot, ...segments, 'archivo-日本語.json');
  let outcome;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFlushed(target, jsonBytes({ schemaVersion: '1.0.0', label: 'ruta larga', revision: 1 }));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).label, 'ruta larga');
    outcome = `created/read ${target.length}-character path`;
  } catch (error) {
    outcome = `unsupported here: ${error.code || error.message}`;
  }
  record('long-unicode-path', 'attempt >260-character path; report host capability', outcome, true, {
    capability: outcome.startsWith('created/read') ? 'supported in this run' : 'not supported in this run',
    pathLength: target.length,
    limit: 'result applies only to this Node executable, manifest, Windows policy, filesystem and temp root'
  });
}

function testCrashPoints() {
  const points = [
    'before-replace-1',
    'after-replace-1',
    'before-replace-2',
    'after-replace-2',
    'before-commit',
    'after-commit'
  ];
  for (const point of points) {
    const caseInfo = makeCase(`crash-${point}`);
    const applyResult = runWorker('apply', caseInfo.caseRoot, point);
    assert.equal(applyResult.status, 86, `${point}: expected injected exit 86; ${applyResult.stderr || applyResult.stdout}`);
    const recovery = runWorker('recover', caseInfo.caseRoot);
    assert.equal(recovery.status, 0, `${point}: recovery failed; ${recovery.stderr || recovery.stdout}`);
    const hashes = currentHashes(caseInfo);
    const expectedHashes = point === 'after-commit'
      ? caseInfo.files.map((file) => file.afterHash)
      : caseInfo.files.map((file) => file.beforeHash);
    assert.deepEqual(hashes, expectedHashes, `${point}: mixed or unexpected document state`);
    const expected = point === 'after-commit' ? 'both after-hashes (committed)' : 'both before-hashes (rolled back)';
    const observed = `${recovery.stdout.trim()}; ${hashes.map((hash) => hash.slice(0, 12)).join(',')}`;
    record(`crash-${point}`, expected, observed, true, {
      injectionCommand: `node worker.cjs apply <temporary-case-root> ${point}`,
      applyExit: applyResult.status,
      recoveryExit: recovery.status,
      processTerminationOnly: true
    });
  }
}

function testExternalEditBeforeApply() {
  const caseInfo = makeCase('external-before-apply');
  const target = path.join(caseInfo.caseRoot, caseInfo.files[1].path);
  const external = jsonBytes({
    schemaVersion: '1.0.0',
    id: '40000000-0000-4000-8000-000000000002',
    revision: 2,
    title: 'Edición externa',
    content: 'No sobrescribir.'
  });
  writeFlushed(target, external);
  const result = runWorker('apply', caseInfo.caseRoot);
  assert.equal(result.status, 42);
  assert.deepEqual(currentHashes(caseInfo), [caseInfo.files[0].beforeHash, sha256(external)]);
  record('external-edit-before-apply', 'revision/hash preflight stops before first replacement', `${result.stderr.trim()}; original first doc and external second doc preserved`, true, {
    applyExit: result.status
  });
}

function testExternalEditDuringRecovery() {
  const caseInfo = makeCase('external-during-recovery');
  const applyResult = runWorker('apply', caseInfo.caseRoot, 'after-replace-1');
  assert.equal(applyResult.status, 86);
  const target = path.join(caseInfo.caseRoot, caseInfo.files[1].path);
  const external = jsonBytes({
    schemaVersion: '1.0.0',
    id: '40000000-0000-4000-8000-000000000002',
    revision: 2,
    title: 'Edición externa durante recuperación',
    content: 'Bytes externos preservados.'
  });
  writeFlushed(target, external);
  const recovery = runWorker('recover', caseInfo.caseRoot);
  assert.equal(recovery.status, 2);
  const hashes = currentHashes(caseInfo);
  assert.deepEqual(hashes, [caseInfo.files[0].beforeHash, sha256(external)]);
  record('external-edit-after-partial-replace', 'explicit conflict; rollback own replacement and preserve external bytes', `${recovery.stdout.trim()}; first=before-hash, second=external-hash`, true, {
    recoveryExit: recovery.status,
    limitation: 'conflict is surfaced; this harness does not offer a user merge UI'
  });
}

function testCorruptFilePreservation() {
  const caseInfo = makeCase('invalid-json-preserved');
  const badPath = path.join(caseInfo.caseRoot, caseInfo.files[0].path);
  const badBytes = Buffer.from('{"truncated": ', 'utf8');
  writeFlushed(badPath, badBytes);
  const untouchedPath = path.join(caseInfo.caseRoot, caseInfo.files[1].path);
  const untouchedBefore = fs.readFileSync(untouchedPath);
  let parseError = false;
  try { JSON.parse(fs.readFileSync(badPath, 'utf8')); } catch { parseError = true; }
  assert.equal(parseError, true);
  assert.deepEqual(fs.readFileSync(badPath), badBytes);
  assert.deepEqual(fs.readFileSync(untouchedPath), untouchedBefore);
  record('invalid-json-bytes-preserved', 'malformed fixture bytes remain unchanged and separate valid document remains intact', 'bytes preserved by harness; parser diagnostic observed', true, {
    limitation: 'no project reader, degraded-open workflow or restore UI is implemented'
  });
}

function run() {
  assertOwnTempRoot();
  process.stdout.write(`ENV ${JSON.stringify({
    platform: process.platform,
    osRelease: os.release(),
    osVersion: os.version(),
    node: process.version,
    npm: process.env.npm_config_user_agent?.split(' ')[0] || 'run via node/npm; exact npm version in parent command',
    tempRoot,
    tempVolume: fs.statSync(tempRoot).dev
  })}\n`);
  testUtf8AndExistingFileReplacement();
  testSyncApis();
  testExclusiveCreate();
  testLongPath();
  testCrashPoints();
  testExternalEditBeforeApply();
  testExternalEditDuringRecovery();
  testCorruptFilePreservation();
}

try {
  run();
} finally {
  assertOwnTempRoot();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`RESULT ${JSON.stringify({ cases: reports.length, failures })}\n`);
if (failures) process.exitCode = 1;
