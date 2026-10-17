import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexAppServerProvider, CodexProviderError, verifyCodexBinary } from '../src/main/codex-app-server.ts';
import { CodexTurnCoordinator } from '../src/main/codex-turns.ts';

const VERSION = '0.163.0-alpha.10.2';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  closed = false;
  killed = false;
  received = [];
  constructor(onLine = () => {}) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const line = chunk.toString();
        this.received.push(line);
        onLine(line, this);
        callback();
      }
    });
    this.stdin.once('finish', () => this.close());
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', 0, null));
  }
  kill() { this.killed = true; this.close(); return true; }
}

function versionSpawn(version = VERSION) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.write(`codex-cli ${version}\n`);
      child.stdout.end();
      child.emit('close', 0, null);
    });
    return child;
  };
}

async function setup(t, { onLine, handshakeTimeoutMs = 100, maxMessageBytes, stopTimeoutMs } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'a3-codex-app-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, 'codex.exe');
  const executableBytes = Buffer.from('fixture executable bytes for the approved Codex build');
  await writeFile(executablePath, executableBytes);
  const sha256 = createHash('sha256').update(executableBytes).digest('hex');
  const binary = await verifyCodexBinary({ executablePath, expectedVersion: VERSION, expectedSha256: sha256 }, { spawnProcess: versionSpawn() });
  const children = [];
  const calls = [];
  const provider = new CodexAppServerProvider({
    userDataDirectory: root,
    clientVersion: '0.1.0-test',
    binary,
    handshakeTimeoutMs,
    maxMessageBytes,
    stopTimeoutMs,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new FakeChild(onLine);
      children.push(child);
      return child;
    }
  });
  return { provider, root, children, calls, executablePath, sha256 };
}

function successfulHandshake(_line, child) {
  if (JSON.parse(_line).method !== 'initialize') return;
  const response = Buffer.from('{"id":0,"result":{"userAgent":"codex"}}\n');
  child.stdout.write(response.subarray(0, 9));
  setImmediate(() => child.stdout.write(response.subarray(9)));
}

test('provider stays stopped until explicitly started and rejects missing binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a3-codex-empty-'));
  try {
    const provider = new CodexAppServerProvider({ userDataDirectory: root, clientVersion: '0.1.0-test' });
    assert.equal(provider.state, 'not-configured');
    await assert.rejects(provider.start(), (error) => error instanceof CodexProviderError && error.code === 'BINARY_NOT_CONFIGURED');
    assert.equal(provider.state, 'not-configured');
    await assert.rejects(
      verifyCodexBinary({ executablePath: join(root, 'missing-codex.exe'), expectedVersion: VERSION, expectedSha256: '0'.repeat(64) }, { spawnProcess: versionSpawn() }),
      (error) => error.code === 'BINARY_MISSING'
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('binary approval verifies exact SHA-256 and artifact version', async (t) => {
  const { executablePath, sha256 } = await setup(t, { onLine: successfulHandshake });
  await assert.rejects(
    verifyCodexBinary({ executablePath, expectedVersion: VERSION, expectedSha256: '0'.repeat(64) }, { spawnProcess: versionSpawn() }),
    (error) => error.code === 'BINARY_HASH_MISMATCH'
  );
  await assert.rejects(
    verifyCodexBinary({ executablePath, expectedVersion: '0.1.0', expectedSha256: sha256 }, { spawnProcess: versionSpawn() }),
    (error) => error.code === 'VERSION_MISMATCH'
  );
});

test('rechecks the approved executable immediately before spawn', async (t) => {
  const { provider, calls, executablePath } = await setup(t, { onLine: successfulHandshake });
  await writeFile(executablePath, 'changed after the first verification');
  await assert.rejects(provider.start(), (error) => error.code === 'BINARY_HASH_MISMATCH');
  assert.equal(calls.length, 0);
});

test('starts only a verified process in an isolated profile and completes initialize handshake', async (t) => {
  const { provider, calls, children, root } = await setup(t, { onLine: successfulHandshake });
  assert.equal(provider.state, 'stopped');
  assert.equal(calls.length, 0);
  const session = await provider.start();
  assert.deepEqual(session, { providerId: 'codex-app-server', protocolInitialized: true, artifactVersion: VERSION });
  assert.equal(provider.state, 'ready');
  assert.deepEqual(calls[0].args, ['app-server', '--listen', 'stdio://']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, join(root, 'codex-app-server'));
  assert.equal(calls[0].options.env.CODEX_HOME, join(root, 'codex-app-server'));
  for (const secretName of ['ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) assert.equal(secretName in calls[0].options.env, false);
  assert.equal(JSON.parse(children[0].received[0]).method, 'initialize');
  assert.equal(JSON.parse(children[0].received[0]).params.clientInfo.name, 'a3');
  assert.deepEqual(JSON.parse(children[0].received[1]), { method: 'initialized', params: {} });
  await provider.stop();
  assert.equal(provider.state, 'stopped');
  assert.equal(children[0].closed, true);
});

test('stop racing profile preparation prevents process creation', async (t) => {
  const { provider, calls } = await setup(t, { onLine: successfulHandshake });
  const starting = provider.start();
  const stopping = provider.stop();
  await assert.rejects(starting, (error) => error.code === 'START_CANCELLED');
  await stopping;
  assert.equal(calls.length, 0);
  assert.equal(provider.state, 'stopped');
});

test('rejects malformed JSON and cleans up the child', async (t) => {
  const { provider, children } = await setup(t, { onLine: (_line, child) => setImmediate(() => child.stdout.write('{malformed}\n')) });
  await assert.rejects(provider.start(), (error) => error.code === 'MALFORMED_MESSAGE');
  assert.equal(provider.state, 'stopped');
  assert.equal(children[0].closed, true);
});

test('detects a truncated final JSONL frame and cleans up the child', async (t) => {
  const { provider, children } = await setup(t, { onLine: (_line, child) => { child.stdout.write('{"id":0,"result":'); setImmediate(() => child.close()); } });
  await assert.rejects(provider.start(), (error) => error.code === 'TRUNCATED_MESSAGE');
  assert.equal(children[0].closed, true);
});

test('fails closed on handshake timeout and terminates the process', async (t) => {
  const { provider, children } = await setup(t, { handshakeTimeoutMs: 10 });
  await assert.rejects(provider.start(), (error) => error.code === 'HANDSHAKE_TIMEOUT');
  assert.equal(children[0].closed, true);
  assert.equal(provider.state, 'stopped');
});

test('rejects messages that exceed the protocol frame limit', async (t) => {
  const { provider, children } = await setup(t, { maxMessageBytes: 32, onLine: (_line, child) => setImmediate(() => child.stdout.write(`${JSON.stringify({ id: 0, result: { value: 'x'.repeat(64) } })}\n`)) });
  await assert.rejects(provider.start(), (error) => error.code === 'MESSAGE_TOO_LARGE');
  assert.equal(children[0].closed, true);
});

test('post-handshake requests are correlated and notification envelopes carry a connection/sequence', async (t) => {
  const { provider, children } = await setup(t, { onLine: (line, child) => {
    const command = JSON.parse(line);
    if (command.method === 'initialize') successfulHandshake(line, child);
    else if (command.id) setImmediate(() => child.stdout.write(JSON.stringify({ id: command.id, result: {} }) + '\n'));
  } });
  const events = []; provider.subscribe((event) => events.push(event));
  await provider.start();
  await provider.request({ method: 'turn/interrupt', params: { threadId: 'thread_fixture', turnId: 'turn_fixture' } });
  children[0].stdout.write('{"method":"turn/started","params":{}}\n');
  children[0].stdout.write('{"method":"turn/started","params":{}}\n');
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(events[0].connectionId, events[1].connectionId);
  await provider.stop();
});

test('request timeout does not retransmit a cancellation', async (t) => {
  const { provider, children } = await setup(t, { onLine: successfulHandshake });
  await provider.start();
  await assert.rejects(provider.request({ method: 'turn/interrupt', params: { threadId: 'thread_fixture', turnId: 'turn_fixture' } }, 5), { code: 'REQUEST_TIMEOUT' });
  assert.equal(children[0].received.filter((line) => JSON.parse(line).method === 'turn/interrupt').length, 1);
  await provider.stop();
});

test('malformed stream after ready stops the connection and preserves the coordinator transcript', async (t) => {
  const { provider, children, root } = await setup(t, { onLine: successfulHandshake });
  const binding = { projectId: '00000000-0000-4000-8000-000000000001', rootIdentity: 'a'.repeat(64) };
  const coordinator = await CodexTurnCoordinator.open(root, binding, { transport: provider });
  try {
    const session = await coordinator.addSession('thread_fixture', 'provider_session');
    await coordinator.trackTurn(session, 'turn_fixture', '00000000-0000-4000-8000-000000000002');
    await provider.start();
    children[0].stdout.write(JSON.stringify({ method: 'item/completed', params: {
      threadId: 'thread_fixture', turnId: 'turn_fixture', item: { type: 'agentMessage', id: 'message_fixture', text: 'Confirmado' }
    } }) + '\n');
    await coordinator.flush();
    const pending = provider.request({ method: 'turn/interrupt', params: { threadId: 'thread_fixture', turnId: 'turn_fixture' } });
    children[0].stdout.write('{broken}\n');
    await assert.rejects(pending, { code: 'MALFORMED_MESSAGE' });
    await coordinator.flush();
    assert.equal(coordinator.snapshot().transcript[0].text, 'Confirmado');
    assert.equal(coordinator.snapshot().turns[0].status, 'uncertain');
    assert.ok(coordinator.snapshot().diagnostics.includes('MALFORMED_MESSAGE'));
    await assert.rejects(provider.request({ method: 'turn/interrupt', params: { threadId: 'thread_fixture', turnId: 'turn_fixture' } }), { code: 'NOT_READY' });
  } finally { await provider.stop(); await coordinator.close(); }
});

test('reconnect cannot launch another process while the previous child remains uncollected', async (t) => {
  const { provider, children, calls } = await setup(t, { handshakeTimeoutMs: 5, stopTimeoutMs: 5, onLine: (_line, child) => {
    child.stdin.removeAllListeners('finish');
    child.kill = () => false;
  } });
  await assert.rejects(provider.start(), { code: 'PROCESS_STOP_TIMEOUT' });
  await assert.rejects(provider.start(), { code: 'NOT_READY' });
  assert.equal(calls.length, 1);
  children[0].close();
  await provider.stop();
});
