import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GithubPublishing } from '../src/main/github-publishing.ts';
import { githubDestination, OfficialGithubApi, GITHUB_API_VERSION } from '../src/main/github-api.ts';
import { ProtectedGithubVault } from '../src/main/github-vault.ts';
import { inspectGitInstallation, runGithubStaging, gitEnvironment, GITHUB_HTTPS_HELPER } from '../src/main/git-process.ts';
import { LocalGitVersions } from '../src/main/git-versions.ts';
import { validGithubRequest } from '../src/shared/github-publishing.ts';
import { fixtureHost } from '../../../packages/project-store/test/fixture.mjs';
import { cp } from 'node:fs/promises';
const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e6/git/github.json', import.meta.url), 'utf8'));
const secret = 'github_pat_' + 'SYNTHETIC'.repeat(5), head = 'a'.repeat(40), sessionId = randomUUID();
async function removeTemporary(root, prefix) { const path = resolve(root); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith(prefix)); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
function fake() {
  const state = { account: fixture.account, remote: structuredClone(fixture.repository), allowed: true, confirm: true, credential: secret, root: 'C:/fixture', projectId: randomUUID(), head, sourceBranch: 'main', pushes: [], creates: [], grants: [], signal: null };
  const vault = { available: () => true, read: async () => state.credential };
  const source = { snapshot: async () => ({ head: state.head, branch: state.sourceBranch, files: [{ path: 'notes.md', bytes: 7 }], bytes: 17, objects: 3 }), pack: async () => Buffer.from('fixture-pack') };
  const api = { user: async () => structuredClone(state.account), repository: async () => structuredClone(state.remote), create: async (_token, name, visibility) => { state.creates.push({ name, visibility }); return { ...state.remote, visibility }; } };
  const host = { context: async (id) => { assert.equal(id, sessionId); return { root: state.root, projectId: state.projectId }; }, authorize: async (_id, stage) => { state.grants.push(stage); return state.allowed; },
    source: async () => source, confirm: async () => state.confirm, push: async (input, signal) => { state.pushes.push(input); state.signal = signal; } };
  return { state, service: new GithubPublishing(api, vault, host), host, api, vault, source, review: { kind: 'push', url: fixture.url, branch: 'main', visibility: 'private' } };
}
test('strict Github IPC and HTTPS destinations reject arbitrary roots, token payloads, credentials and lookalike hosts', () => {
  assert.equal(GITHUB_API_VERSION, fixture.apiVersion);
  for (const url of ['https://github.com.evil/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a/b?token=x', 'git@github.com:a/b', 'file:///tmp/repo', 'https://github.com/a/..', 'https://github.com/a/b/extra']) assert.throws(() => githubDestination(url));
  assert.equal(githubDestination('https://github.com/a/b').url, 'https://github.com/a/b.git');
  for (const input of [null, { action: 'status', sessionId, root: 'C:/other' }, { action: 'connect-manual', sessionId, accessToken: secret }, { action: 'apply', sessionId, token: 'forged' }, { action: 'review', sessionId, kind: 'push', url: fixture.url, visibility: 'private', root: 'main' }]) assert.equal(validGithubRequest(input), false);
  assert.equal(validGithubRequest({ action: 'review', sessionId, kind: 'push', url: fixture.url, branch: 'main', visibility: 'private' }), true);
});
test('A3-035 review shows verified identity/destination/visibility/branch/exclusions; only explicit apply can push', async () => {
  const c = fake(), review = await c.service.review(sessionId, c.review);
  assert.deepEqual(review.account, fixture.account); assert.equal(review.url, fixture.url); assert.equal(review.visibility, 'private'); assert.equal(review.branch, 'main'); assert.equal(review.remoteId, 8001); assert.ok(review.exclusions.includes('.a3/local'));
  assert.equal(JSON.stringify(review).includes(secret), false); assert.equal(c.state.pushes.length, 0);
  await assert.rejects(c.service.apply(sessionId, review.token, 'https://github.com/a3-fixture/other.git'), { code: 'destination-mismatch' }); assert.equal(c.state.pushes.length, 0);
  const result = await c.service.apply(sessionId, review.token, review.url); assert.equal(result.completed, 'pushed'); assert.equal(c.state.pushes.length, 1); assert.equal(c.state.pushes[0].url, fixture.url); assert.equal(c.state.pushes[0].head, head);
  assert.equal(JSON.stringify(result).includes(secret), false); await assert.rejects(c.service.apply(sessionId, review.token, review.url), { code: 'review-expired' });
});
test('cancel review or native confirmation, deny/revoke permission and stale projects never publish', async () => {
  for (const kind of ['cancel', 'confirm', 'denied', 'root', 'project', 'head', 'branch', 'token']) {
    const c = fake(), review = await c.service.review(sessionId, c.review);
    if (kind === 'cancel') c.service.cancel(sessionId, review.token);
    if (kind === 'confirm') c.state.confirm = false;
    if (kind === 'denied') c.state.allowed = false;
    if (kind === 'root') c.state.root = 'C:/other';
    if (kind === 'project') c.state.projectId = randomUUID();
    if (kind === 'head') c.state.head = 'b'.repeat(40);
    if (kind === 'branch') c.state.sourceBranch = 'other';
    if (kind === 'token') c.state.credential += 'changed';
    await assert.rejects(c.service.apply(sessionId, review.token, review.url)); assert.equal(c.state.pushes.length, 0);
  }
});
test('repository identity, visibility, remote permission and account are rechecked before sending', async () => {
  for (const kind of ['id', 'fullName', 'visibility', 'canPush', 'account']) {
    const c = fake(), review = await c.service.review(sessionId, c.review);
    if (kind === 'id') c.state.remote.id++;
    if (kind === 'fullName') c.state.remote.fullName = 'a3-fixture/other';
    if (kind === 'visibility') c.state.remote.visibility = 'public';
    if (kind === 'canPush') c.state.remote.canPush = false;
    if (kind === 'account') c.state.account = { id: 33, login: 'other' };
    await assert.rejects(c.service.apply(sessionId, review.token, review.url)); assert.equal(c.state.pushes.length, 0);
  }
  const c = fake(); c.state.remote.visibility = 'public'; await assert.rejects(c.service.review(sessionId, c.review), { code: 'visibility-mismatch' });
});
test('create defaults chosen private, is personal-only and does not implicitly push or retry', async () => {
  const c = fake(); await assert.rejects(c.service.review(sessionId, { ...c.review, kind: 'create', url: 'https://github.com/other/project.git' }), { code: 'create-owner-mismatch' });
  const review = await c.service.review(sessionId, { ...c.review, kind: 'create' }); const result = await c.service.apply(sessionId, review.token, review.url);
  assert.equal(result.completed, 'created'); assert.deepEqual(c.state.creates, [{ name: 'project', visibility: 'private' }]); assert.equal(c.state.pushes.length, 0);
});
test('in-flight cancel/revocation aborts transport and reports uncertain remote outcome, never repeats', async () => {
  const c = fake(); let started; const ready = new Promise((accept) => { started = accept; });
  c.host.push = async (_input, signal) => { started(); await new Promise((_accept, reject) => signal.addEventListener('abort', () => reject(new Error('raw secret must not escape: ' + secret)), { once: true })); };
  const review = await c.service.review(sessionId, c.review), applying = c.service.apply(sessionId, review.token, review.url); await ready; c.service.cancelAll();
  await assert.rejects(applying, { code: 'remote-result-uncertain' }); await assert.rejects(c.service.apply(sessionId, review.token, review.url), { code: 'review-expired' });
});
test('official API fixes version/origin, disallows redirect, redacts errors, validates identity and creates explicit privacy', async () => {
  const calls = [], api = new OfficialGithubApi(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(url.endsWith('/user') ? fixture.account : { id: 8001, full_name: 'a3-fixture/project', private: true, permissions: { push: true } }), { status: options.method === 'POST' ? 201 : 200 }); });
  assert.deepEqual(await api.user(secret), fixture.account); assert.equal((await api.repository(secret, fixture.url)).canPush, true); await api.create(secret, 'project', 'private');
  assert.equal(calls[0].url, 'https://api.github.com/user'); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], fixture.apiVersion);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { name: 'project', private: true, auto_init: false });
  for (const status of [401, 403, 404, 422]) { const failing = new OfficialGithubApi(async () => new Response(secret, { status })); await assert.rejects(failing.user(secret), (error) => !String(error).includes(secret)); }
  const broken = new OfficialGithubApi(async () => { throw new Error(secret); }); await assert.rejects(broken.create(secret, 'project', 'private'), { code: 'remote-result-uncertain' });
});
test('protected vault has no plaintext fallback, preserves corrupt bytes and clears only its own credential', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'a3-github-vault-')); t.after(() => removeTemporary(root, 'a3-github-vault-'));
  const key = randomBytes(32), iv = randomBytes(12), encryption = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-only', encryptString: (text) => { const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([cipher.getAuthTag(), data]); }, decryptString: (data) => { const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(data.subarray(0, 16)); return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString(); } };
  const vault = new ProtectedGithubVault(root, encryption, 'win32'); assert.equal(await vault.read(), null); await vault.save(secret); assert.equal(await vault.read(), secret);
  const path = join(root, 'github-authorization/credentials.bin'), bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(new ProtectedGithubVault(root, encryption, 'linux').available(), false); await assert.rejects(new ProtectedGithubVault(root, encryption, 'linux').save(secret));
  await writeFile(path, 'corrupt'); await assert.rejects(vault.read()); assert.equal(await readFile(path, 'utf8'), 'corrupt'); await vault.clear(); assert.deepEqual(await readdir(join(root, 'github-authorization')), []);
});
const installation = await inspectGitInstallation(), native = { skip: installation.state !== 'available' ? 'Verified Windows Git is optional' : false }, exec = promisify(execFile);
async function repository(t) {
  const base = await mkdtemp(join(tmpdir(), 'a3-github-native-')), root = join(base, 'project ñ'); await mkdir(root);
  t.after(async () => { assert.equal(dirname(resolve(base)), resolve(tmpdir())); assert.ok(basename(base).startsWith('a3-github-native-')); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const git = async (cwd, ...args) => (await exec(installation.binary.path, ['-c', 'core.autocrlf=false', '-c', 'user.name=A3 fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env: gitEnvironment(cwd), windowsHide: true, encoding: 'utf8' })).stdout;
  await writeFile(join(root, 'notes.md'), 'initial\n'); await git(root, 'init', '-b', 'main'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: initial');
  const service = await LocalGitVersions.open(installation, { repositoryId: 'project', projectId: randomUUID(), kind: 'a3-project', root }, { authorize: async () => true, hasDirtyBuffers: async () => false, prepareRestore: async () => { throw new Error('not used'); } });
  return { base, root, git, service };
}
test('native history pack preserves exact commits, unpack uses isolated config; HTTPS helper is pinned', native, async (t) => {
  const c = await repository(t), snapshot = await c.service.publishingSnapshot(); assert.deepEqual(snapshot.files.map((file) => file.path), ['notes.md']); assert.equal(snapshot.objects, 3);
  const index = await readFile(join(c.root, '.git/index')), config = await readFile(join(c.root, '.git/config')), staging = join(c.base, 'staging'); await mkdir(staging);
  await runGithubStaging(installation.binary, staging, { kind: 'init' }); await runGithubStaging(installation.binary, staging, { kind: 'unpack', pack: await c.service.publishingPack(snapshot.head) });
  assert.equal((await c.git(staging, 'cat-file', '-t', snapshot.head)).trim(), 'commit'); assert.equal(await c.git(staging, 'show', snapshot.head + ':notes.md'), 'initial\n');
  await assert.rejects(runGithubStaging(installation.binary, staging, { kind: 'push', url: 'https://evil.invalid/a/b', branch: 'main', oid: snapshot.head, token: secret }));
  const helper = join(dirname(installation.binary.path), '../libexec/git-core/git-remote-https.exe'); assert.equal(createHash('sha256').update(await readFile(helper)).digest('hex'), GITHUB_HTTPS_HELPER.sha256);
  assert.deepEqual(await readFile(join(c.root, '.git/index')), index); assert.deepEqual(await readFile(join(c.root, '.git/config')), config);
  await writeFile(join(staging, 'config'), '[core]\n bare = true\n[credential]\n helper = unexpected\n');
  await assert.rejects(runGithubStaging(installation.binary, staging, { kind: 'unpack', pack: await c.service.publishingPack(snapshot.head) }), { code: 'invalid-staging' });
});
test('historical secrets and protected files still block after deletion; current LFS and symlinks cannot publish', native, async (t) => {
  for (const scenario of ['secret', 'protected', 'lfs', 'symlink']) {
    const c = await repository(t), path = scenario === 'protected' ? '.env' : 'notes.md';
    if (scenario === 'symlink') {
      const oid = (await c.git(c.root, 'rev-parse', 'HEAD:notes.md')).trim(); await c.git(c.root, 'update-index', '--add', '--cacheinfo', `120000,${oid},linked-file`); await c.git(c.root, 'commit', '-m', 'test: linked entry');
      await assert.rejects(c.service.publishingSnapshot(), { code: 'unsupported-history' }); continue;
    }
    await writeFile(join(c.root, path), scenario === 'secret' ? 'api_key = synthetic-value\n' : scenario === 'lfs' ? 'version https://git-lfs.github.com/spec/v1\n' : 'do not upload\n');
    await c.git(c.root, 'add', '--', path); await c.git(c.root, 'commit', '-m', 'test: historical content'); await rm(join(c.root, path)); await c.git(c.root, 'add', '--all'); await c.git(c.root, 'commit', '-m', 'test: remove content');
    await assert.rejects(c.service.publishingSnapshot());
  }
});
test('real broker keeps Github permission separate from generic network and rejects cloned/agent elevation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'a3-github-broker-')); t.after(() => removeTemporary(root, 'a3-github-broker-'));
  const project = join(root, 'project'); await cp(new URL('../../../fixtures/e0/project', import.meta.url), project, { recursive: true });
  let approve = true; const host = await fixtureHost(project, 'fixture-user', 'proponer', () => approve); approve = false;
  assert.equal((await host.capabilities.authorizeCapabilities(project, host.authenticatedActor, host.projectId, ['git.push'], 'github.publish', 'prepare')).allowed, true);
  assert.equal((await host.capabilities.authorizeCapabilities(project, host.authenticatedActor, host.projectId, ['git.push'], 'github.publish', 'apply')).allowed, false);
  assert.equal((await host.capabilities.authorizeCapabilities(project, { kind: 'agent', id: 'fake' }, host.projectId, ['git.push'], 'github.publish', 'apply')).allowed, false);
  assert.equal((await host.capabilities.authorizeCapabilities(project, host.authenticatedActor, host.projectId, ['network.access'], 'github.publish', 'apply')).reason, 'capability-unavailable');
  const clone = join(root, 'clone'); await cp(project, clone, { recursive: true });
  assert.equal((await host.capabilities.authorizeCapabilities(clone, host.authenticatedActor, host.projectId, ['git.push'], 'github.publish', 'prepare')).allowed, false);
  approve = true; assert.equal((await host.capabilities.authorizeCapabilities(project, host.authenticatedActor, host.projectId, ['git.push'], 'github.publish', 'apply')).allowed, true);
});
