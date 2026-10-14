'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const [mode, caseRoot, crashAt = ''] = process.argv.slice(2);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeSynced(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function appendJournal(journalPath, event) {
  const fd = fs.openSync(journalPath, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(event)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJournal(journalPath) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function readMeta() {
  const metaPath = path.join(caseRoot, 'transaction.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.harnessMarker !== 'a3-e0-c1-test-data') {
    fail('refusing to touch a directory without the E0-C1 synthetic-data marker');
  }
  return meta;
}

function assertTemporaryCaseRoot() {
  const tempBase = fs.realpathSync(os.tmpdir());
  const resolved = path.resolve(caseRoot);
  const relative = path.relative(tempBase, resolved);
  const firstSegment = relative.split(path.sep)[0];
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !firstSegment.startsWith('a3-e0-c1-')) {
    fail(`refusing to operate outside an E0-C1 temporary directory: ${resolved}`);
  }
  const actual = fs.realpathSync(resolved);
  const actualRelative = path.relative(tempBase, actual);
  if (!actualRelative || actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
    fail(`refusing a temporary case that resolves outside the temp directory: ${actual}`);
  }
}

function crash(point) {
  if (crashAt === point) {
    process.stdout.write(`INJECTED_PROCESS_EXIT ${point}\n`);
    process.exit(86);
  }
}

function apply() {
  const meta = readMeta();
  const journalPath = path.join(caseRoot, meta.journalPath);
  const journal = readJournal(journalPath);
  if (!journal.some((entry) => entry.event === 'prepared')) {
    fail('journal has no prepared event');
  }

  for (let index = 0; index < meta.files.length; index += 1) {
    const file = meta.files[index];
    const target = path.join(caseRoot, file.path);
    if (hashFile(target) !== file.beforeHash) {
      fail(`REVISION_CONFLICT ${file.path}`, 42);
    }
  }

  for (let index = 0; index < meta.files.length; index += 1) {
    const file = meta.files[index];
    const ordinal = index + 1;
    const target = path.join(caseRoot, file.path);
    const staged = path.join(caseRoot, file.stagedPath);
    if (hashFile(target) !== file.beforeHash) {
      fail(`REVISION_CONFLICT ${file.path}`, 42);
    }

    crash(`before-replace-${ordinal}`);
    try {
      fs.renameSync(staged, target);
    } catch (error) {
      fail(`REPLACE_FAILED ${file.path} ${error.code || error.message}`, 43);
    }
    crash(`after-replace-${ordinal}`);
    appendJournal(journalPath, {
      event: 'replaced',
      path: file.path,
      sha256: file.afterHash,
      ordinal
    });
  }

  for (const file of meta.files) {
    if (hashFile(path.join(caseRoot, file.path)) !== file.afterHash) {
      fail(`POST_WRITE_HASH_MISMATCH ${file.path}`, 44);
    }
  }

  crash('before-commit');
  appendJournal(journalPath, { event: 'committed', operationId: meta.operationId });
  crash('after-commit');
  process.stdout.write('APPLY_COMMITTED\n');
}

function restoreFromBackup(file, meta) {
  const target = path.join(caseRoot, file.path);
  const backup = path.join(caseRoot, file.backupPath);
  const restorePath = path.join(caseRoot, file.restorePath);
  const bytes = fs.readFileSync(backup);
  writeSynced(restorePath, bytes);
  fs.renameSync(restorePath, target);
  return hashFile(target) === file.beforeHash;
}

function recover() {
  const meta = readMeta();
  const journalPath = path.join(caseRoot, meta.journalPath);
  const journal = readJournal(journalPath);
  const hasCommit = journal.some((entry) => entry.event === 'committed');

  if (hasCommit) {
    const mismatches = meta.files
      .filter((file) => hashFile(path.join(caseRoot, file.path)) !== file.afterHash)
      .map((file) => file.path);
    if (mismatches.length) {
      appendJournal(journalPath, { event: 'recovery-conflict', reason: 'committed-hash-mismatch', paths: mismatches });
      process.stdout.write(`RECOVERY_CONFLICT committed-hash-mismatch ${mismatches.join(',')}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write('RECOVERY_COMMITTED all-after-hashes-match\n');
    return;
  }

  const conflicts = [];
  const restored = [];
  for (const file of meta.files) {
    const target = path.join(caseRoot, file.path);
    const currentHash = hashFile(target);
    if (currentHash === file.beforeHash) continue;
    if (currentHash === file.afterHash) {
      if (!restoreFromBackup(file, meta)) {
        conflicts.push(file.path);
      } else {
        restored.push(file.path);
      }
      continue;
    }
    conflicts.push(file.path);
  }

  if (conflicts.length) {
    appendJournal(journalPath, { event: 'recovery-conflict', reason: 'external-hash-mismatch', paths: conflicts });
    process.stdout.write(`RECOVERY_CONFLICT external-hash-mismatch preserved=${conflicts.join(',')} restored=${restored.join(',')}\n`);
    process.exitCode = 2;
    return;
  }

  appendJournal(journalPath, { event: 'recovered-rollback', restored });
  process.stdout.write(`RECOVERY_ROLLED_BACK restored=${restored.join(',') || 'none'}\n`);
}

if (!caseRoot || !['apply', 'recover'].includes(mode)) {
  fail('usage: node worker.cjs <apply|recover> <temporary-case-root> [crash-point]');
}

try {
  assertTemporaryCaseRoot();
  if (mode === 'apply') apply();
  else recover();
} catch (error) {
  fail(`WORKER_ERROR ${error.code || error.message}`);
}
