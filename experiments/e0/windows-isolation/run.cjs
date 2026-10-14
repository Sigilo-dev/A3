'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const tempBase = fs.realpathSync(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'a3-e0-c2-'));
const grantedRoot = path.join(tempRoot, 'granted');
const outsideRoot = path.join(tempRoot, 'ungranted');
const marker = 'a3-e0-c2 synthetic sentinel';
const markerPath = path.join(outsideRoot, 'sentinel.json');
const reports = [];
let failures = 0;
let child;
let childClosed;

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertOwnTempRoot() {
  const resolved = path.resolve(tempRoot);
  const base = path.resolve(tempBase);
  if (!resolved.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`) || !path.basename(resolved).startsWith('a3-e0-c2-')) {
    throw new Error('refusing to clean a path not created by this runner');
  }
}

function record(name, expected, observed, pass, details = {}) {
  reports.push({ name, expected, observed, pass, ...details });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(reports.at(-1))}\n`);
  if (!pass) failures += 1;
}

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveWithinGrantedRoot(candidate) {
  const realRoot = fs.realpathSync(grantedRoot);
  const lexical = path.resolve(grantedRoot, candidate);
  if (!isWithin(grantedRoot, lexical)) throw policyError('PATH_OUTSIDE_GRANTED_ROOT');

  let resolved;
  try {
    resolved = fs.realpathSync(lexical);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = fs.realpathSync(path.dirname(lexical));
    resolved = path.join(parent, path.basename(lexical));
  }
  if (!isWithin(realRoot, resolved)) throw policyError('PATH_OUTSIDE_GRANTED_ROOT');
  return resolved;
}

function hostRead(candidate, effective) {
  if (!effective.read) throw policyError('PERMISSION_DENIED');
  return fs.readFileSync(resolveWithinGrantedRoot(candidate), 'utf8');
}

function hostWrite(candidate, value, effective) {
  if (!effective.write) throw policyError('PERMISSION_DENIED');
  const destination = resolveWithinGrantedRoot(candidate);
  fs.writeFileSync(destination, value, 'utf8');
}

function expectCode(action, expectedCode) {
  assert.throws(action, (error) => error.code === expectedCode);
}

function startChild() {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    env.TEMP = tempRoot;
    env.TMP = tempRoot;

    child = spawn(process.execPath, [path.join(__dirname, 'child.cjs'), tempRoot], {
      cwd: tempRoot,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.__a3Lines = lines;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    childClosed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));

    const timer = setTimeout(() => reject(new Error(`child ready timeout: ${stderr}`)), 5000);
    lines.once('line', (line) => {
      clearTimeout(timer);
      let value;
      try { value = JSON.parse(line); } catch (error) { reject(error); return; }
      if (!value.ready) { reject(new Error(`child did not become ready: ${line}; ${stderr}`)); return; }
      resolve({ lines, stderr: () => stderr });
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function sendChild(command, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child response timeout for ${command}`)), 5000);
    const waiter = (line) => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value.ready) return;
      clearTimeout(timer);
      rl.removeListener('line', waiter);
      resolve(value);
    };
    const rl = child.__a3Lines;
    rl.once('line', waiter);
    child.stdin.write(`${JSON.stringify({ command, ...message })}\n`);
  });
}

function profilesAndFallback() {
  const policy = {
    Consultar: { read: true, write: false, process: false, network: 'provider-only' },
    Proponer: { read: true, write: 'staged-after-approval', process: 'approval-plus-isolation', network: 'explicit-plus-isolation' },
    Trabajar: { read: true, write: 'granted-root', process: 'project-rules-plus-isolation', network: 'explicit-plus-isolation' }
  };
  const projectRequest = { read: ['*'], write: ['*'], process: true, network: true };
  const localEffective = { read: [grantedRoot], write: [grantedRoot], process: false, network: false };
  fs.writeFileSync(path.join(tempRoot, 'project-policy-request.json'), `${JSON.stringify(projectRequest, null, 2)}\n`, 'utf8');
  assert.deepEqual(localEffective.read, [grantedRoot]);
  assert.equal(localEffective.process, false);
  assert.equal(localEffective.network, false);

  let spawned = 0;
  function processGate(profile, isolationAvailable, spawnCommand) {
    if (profile === 'Consultar' || !isolationAvailable) return 'PROCESS_DISABLED_ISOLATION_UNAVAILABLE';
    spawned += 1;
    spawnCommand();
    return 'PROCESS_ALLOWED_BY_TEST_POLICY';
  }
  assert.equal(processGate('Consultar', true, () => { spawned += 100; }), 'PROCESS_DISABLED_ISOLATION_UNAVAILABLE');
  assert.equal(processGate('Proponer', false, () => { spawned += 100; }), 'PROCESS_DISABLED_ISOLATION_UNAVAILABLE');
  assert.equal(processGate('Trabajar', false, () => { spawned += 100; }), 'PROCESS_DISABLED_ISOLATION_UNAVAILABLE');
  assert.equal(spawned, 0);
  record('project-request-does-not-expand-local-grant-and-unavailable-isolation-fails-closed', 'broad cloned request cannot elevate local grants; Consultar and commands without isolation do not spawn', 'assertions passed; this is a test-only policy simulation', true, {
    profiles: policy,
    localEffective: { ...localEffective, read: ['<temporary-granted-root>'], write: ['<temporary-granted-root>'] },
    projectRequestIgnoredForGrant: true,
    simulatedOnly: true
  });
}

async function run() {
  assertOwnTempRoot();
  fs.mkdirSync(grantedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(grantedRoot, 'input.txt'), 'granted synthetic text\n', 'utf8');
  fs.writeFileSync(markerPath, marker, 'utf8');

  const effective = { read: true, write: true };
  assert.equal(hostRead('input.txt', effective), 'granted synthetic text\n');
  hostWrite('host-created.txt', 'host write in granted root\n', effective);
  assert.equal(fs.readFileSync(path.join(grantedRoot, 'host-created.txt'), 'utf8'), 'host write in granted root\n');
  record('host-mediated-read-write-within-granted-root', 'read and write succeed under the granted root', 'passed using test-only capability and path checks', true, {
    syntheticFixturesOnly: true
  });

  const beforeSentinel = fs.readFileSync(markerPath, 'utf8');
  expectCode(() => hostRead(path.join('..', 'ungranted', 'sentinel.json'), effective), 'PATH_OUTSIDE_GRANTED_ROOT');
  expectCode(() => hostWrite(path.join('..', 'ungranted', 'host-escape.txt'), 'must not exist', effective), 'PATH_OUTSIDE_GRANTED_ROOT');
  expectCode(() => hostRead('input.txt', { read: false }), 'PERMISSION_DENIED');
  assert.equal(fs.existsSync(path.join(outsideRoot, 'host-escape.txt')), false);
  assert.equal(fs.readFileSync(markerPath, 'utf8'), beforeSentinel);
  record('host-denies-relative-escape-and-revoked-read', 'outside read/write and read without capability are denied; outside bytes unchanged', 'all negative assertions passed', true);

  let junctionAvailable = true;
  let junctionError = '';
  const junctionPath = path.join(grantedRoot, 'junction-out');
  try {
    fs.symlinkSync(outsideRoot, junctionPath, 'junction');
  } catch (error) {
    junctionAvailable = false;
    junctionError = error.code || error.message;
  }

  if (junctionAvailable) {
    expectCode(() => hostRead(path.join('junction-out', 'sentinel.json'), effective), 'PATH_OUTSIDE_GRANTED_ROOT');
    expectCode(() => hostWrite(path.join('junction-out', 'host-junction.txt'), 'must not exist', effective), 'PATH_OUTSIDE_GRANTED_ROOT');
    assert.equal(fs.existsSync(path.join(outsideRoot, 'host-junction.txt')), false);
  }
  record('host-rejects-junction-escape', 'junction if available resolves outside grant and is rejected for read/write', junctionAvailable ? 'junction created; host rejected both paths' : `not exercised; junction creation failed with ${junctionError}`, junctionAvailable, {
    junctionAvailable,
    junctionError: junctionError || undefined,
    limitation: 'a preflight realpath check is subject to time-of-check/time-of-use races; this is not a kernel-enforced mount sandbox'
  });

  profilesAndFallback();

  const running = await startChild();
  child.__a3Lines = running.lines;
  // Revoke the host's logical grant while the same child session is alive.
  effective.read = false;
  effective.write = false;
  expectCode(() => hostRead('input.txt', effective), 'PERMISSION_DENIED');
  expectCode(() => hostWrite('post-revocation.txt', 'must not exist', effective), 'PERMISSION_DENIED');
  const raw = await sendChild('raw-probe', {});
  assert.equal(raw.traversalReadSucceeded, true);
  assert.equal(raw.traversalWriteSucceeded, true);
  assert.equal(raw.junctionReadSucceeded, junctionAvailable);
  assert.equal(raw.junctionWriteSucceeded, junctionAvailable);
  assert.equal(fs.existsSync(path.join(outsideRoot, 'child-created.json')), true);
  record('ordinary-child-bypasses-logical-grant-even-after-revocation', 'the host denies after revoke; a standard Node child with the same logon token can still read/write the synthetic outside fixture', 'host denial passed; child outside read/write succeeded' + (junctionAvailable ? ' through traversal and junction' : ' through traversal; junction unavailable'), true, {
    childProcess: 'node:child_process spawn; same Windows user token by default; environment allowlisted but no restricted token/AppContainer',
    childReadOutsideGrant: raw.traversalReadSucceeded,
    childWriteOutsideGrant: raw.traversalWriteSucceeded,
    childReadViaJunction: raw.junctionReadSucceeded,
    childWriteViaJunction: raw.junctionWriteSucceeded,
    revocationAffectsExistingChild: false,
    rawProbeTarget: 'synthetic files under this runner temp root only'
  });

  const stopped = await sendChild('shutdown', {});
  assert.equal(stopped.stopped, true);
  const close = await childClosed;
  assert.equal(close.code, 0);
  record('test-child-stopped-and-session-revocation-completed', 'child acknowledges stop and exits cleanly; host checks deny after revocation', `child exit=${close.code}; signal=${close.signal || 'none'}`, true, {
    limitation: 'no production broker, process tree, Job Object, or real ACL revocation was exercised'
  });
}

async function main() {
  const started = new Date().toISOString();
  try {
    assertOwnTempRoot();
    process.stdout.write(`ENV ${JSON.stringify({ platform: process.platform, release: os.release(), version: os.version(), node: process.version, volume: fs.statSync(tempRoot).dev })}\n`);
    await run();
  } catch (error) {
    failures += 1;
    process.stderr.write(`ERROR ${error.stack || error.message}\n`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (childClosed) await childClosed;
    }
    assertOwnTempRoot();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.stdout.write(`RESULT ${JSON.stringify({ started, ended: new Date().toISOString(), cases: reports.length, failures, tempDataCleaned: true })}\n`);
    if (failures) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`FATAL ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
