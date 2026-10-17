import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { GIT_STATUS_ENGINE, inspectGitInstallation, gitEnvironment, validateGitBinary } from '../src/main/git-process.ts';
import { LocalGitStatusAdapter, parseGitStatus } from '../src/main/git-status.ts';

const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e6/git/status.json', import.meta.url), 'utf8'));
const installation = await inspectGitInstallation();
const native = { skip: installation.state !== 'available' ? 'Requires the exact verified optional Git for Windows build' : false };
const exec = promisify(execFile);
const host = { authorize: async () => true };
const oid = 'a'.repeat(40);
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'a3 git español & '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function git(root, args) {
  assert.equal(installation.state, 'available');
  return exec(installation.binary.path, args, { cwd: root, env: gitEnvironment(root), windowsHide: true, encoding: 'utf8' });
}
async function file(root, path, content = 'fixture\n') {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function repo(root) { await mkdir(root, { recursive: true }); await git(root, ['init', '--initial-branch=main']); }
async function bind(adapter, root, repositoryId = 'project', kind = 'a3-project') {
  await adapter.bind({ repositoryId, projectId: fixture.projectId, kind, root });
}

test('engine metadata records the exact locally verified GPLv2 system executable', () => {
  assert.equal(GIT_STATUS_ENGINE.version, fixture.engine.version);
  assert.equal(GIT_STATUS_ENGINE.bytes, fixture.engine.bytes);
  assert.equal(GIT_STATUS_ENGINE.sha256, fixture.engine.sha256);
  assert.equal(GIT_STATUS_ENGINE.license, fixture.engine.license);
  assert.equal(gitEnvironment(tmpdir()).GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(gitEnvironment(tmpdir()).GIT_OPTIONAL_LOCKS, '0');
  assert.equal(gitEnvironment(tmpdir()).GIT_SSH_COMMAND, undefined);
  assert.equal(gitEnvironment(tmpdir()).NODE_OPTIONS, undefined);
});

test('missing executable is not-installed; an arbitrary file and forged verification cannot execute', async (t) => {
  const root = await scratch(t), missing = await inspectGitInstallation(join(root, 'missing.exe'));
  assert.equal(missing.state, 'not-installed');
  const adapter = new LocalGitStatusAdapter(missing, host);
  await bind(adapter, root);
  assert.equal((await adapter.status('project')).state, 'not-installed');
  await file(root, 'fake.exe', 'not a program');
  assert.equal((await inspectGitInstallation(join(root, 'fake.exe'))).state, 'unverified-binary');
  await assert.rejects(validateGitBinary({ path: join(root, 'fake.exe'), version: fixture.engine.version, sha256: fixture.engine.sha256 }), { code: 'unverified-binary' });
  await assert.rejects(access(join(root, '.git')));
});

test('porcelain v2 parser preserves Unicode, spaces and newline paths, separates index/worktree and ignores upstream', () => {
  const source = `# branch.oid ${oid}\0# branch.head main\0# branch.upstream private-remote/main\0` +
    `1 .M N... 100644 100644 100644 ${oid} ${oid} docs/guía ñ.md\0? text with\nnewline.md\0` +
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.md\0`;
  const state = parseGitStatus(Buffer.from(source));
  assert.equal(state.branch, 'main'); assert.equal(state.head, oid);
  assert.deepEqual(state.entries.map((entry) => [entry.kind, entry.path, entry.index, entry.worktree]), [
    ['tracked', 'docs/guía ñ.md', '.', 'M'], ['untracked', 'text with\nnewline.md', '?', '?'], ['unmerged', 'conflict.md', 'U', 'U']
  ]);
  assert.equal(JSON.stringify(state).includes('private-remote'), false);
  assert.equal(parseGitStatus(Buffer.from(`# branch.oid ${oid}\0# branch.head (detached)\0`)).branch, null);
});

test('invalid UTF-8, truncated output, traversal and unknown entry types cannot become clean status', () => {
  for (const bytes of [Buffer.from([255, 0]), Buffer.from('# branch.head main'), Buffer.from(`# branch.oid ${oid}\0# branch.head main\0? ../outside.md\0`),
    Buffer.from(`# branch.oid ${oid}\0# branch.head main\0x unsupported\0`)]) assert.throws(() => parseGitStatus(bytes), { code: 'invalid-output' });
});

test('A3-034 subset: Unicode/space roots and filenames round-trip, protected tracked paths are excluded, index stays exact', native, async (t) => {
  const root = await scratch(t); await repo(root);
  for (const path of [...fixture.visibleFiles, ...fixture.protectedFiles]) await file(root, path);
  await git(root, ['add', '--', fixture.visibleFiles[0], ...fixture.protectedFiles]);
  await git(root, ['-c', 'user.name=A3 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: fixture']);
  await file(root, fixture.visibleFiles[0], 'changed ñ\n');
  for (const path of fixture.protectedFiles) await file(root, path, 'private changed fixture\n');
  for (const path of ['.a3/local/untracked.json', 'sub/.env.ignored', 'cache/temporary.bin', 'credentials.txt', '.ENV.production']) await file(root, path);
  await file(root, '.gitignore', 'ignored-by-project.txt\n!.env\n!.a3/local/**\n'); await file(root, 'ignored-by-project.txt');
  const before = await readFile(join(root, '.git/index'));
  const adapter = new LocalGitStatusAdapter(installation, host); await bind(adapter, root);
  const status = await adapter.status('project');
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.branch, 'main'); assert.equal(status.kind, 'a3-project'); assert.equal(status.unborn, false);
  assert.deepEqual(status.entries.map((entry) => entry.path).sort(), [...fixture.visibleFiles, '.gitignore'].sort());
  assert.equal(status.entries.find((entry) => entry.path === fixture.visibleFiles[0]).worktree, 'M');
  assert.equal(status.excludedTrackedCount, fixture.protectedFiles.length);
  assert.deepEqual(status.diagnostics, ['PROTECTED_TRACKED_FILES']);
  assert.deepEqual(await readFile(join(root, '.git/index')), before);
  assert.equal((await readFile(join(root, fixture.protectedFiles[0]), 'utf8')), 'private changed fixture\n');
});

test('project and referenced repositories keep separate identities, scopes, branches and no inferred parent repository', native, async (t) => {
  const base = await scratch(t), project = join(base, 'A3 project'), external = join(base, 'referenciado ñ');
  await repo(project); await repo(external);
  await git(external, ['symbolic-ref', 'HEAD', 'refs/heads/externo']);
  await file(project, 'only-project.md'); await file(external, 'only-external.md');
  const adapter = new LocalGitStatusAdapter(installation, host);
  await bind(adapter, project); await bind(adapter, external, 'external', 'referenced');
  const [a, b] = await Promise.all([adapter.status('project'), adapter.status('external')]);
  assert.equal(a.state, 'ready'); assert.equal(b.state, 'ready');
  assert.equal(a.branch, 'main'); assert.equal(b.branch, 'externo'); assert.equal(b.kind, 'referenced');
  assert.equal(a.unborn, true); assert.equal(b.unborn, true);
  assert.deepEqual(a.entries.map((e) => e.path), ['only-project.md']); assert.deepEqual(b.entries.map((e) => e.path), ['only-external.md']);
  await assert.rejects(adapter.status('unapproved'), { code: 'repository-not-bound' });
  const child = join(project, 'folder'); await mkdir(child); await bind(adapter, child, 'child', 'referenced');
  assert.equal((await adapter.status('child')).state, 'not-repository');
  await assert.rejects(adapter.bind({ repositoryId: 'project', projectId: randomUUID(), kind: 'referenced', root: external }), { code: 'invalid-binding' });
  const inherited = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = join(external, '.git'); process.env.GIT_WORK_TREE = external;
    const unaffected = await adapter.status('project');
    assert.equal(unaffected.state, 'ready'); assert.equal(unaffected.branch, 'main');
    assert.equal(unaffected.entries.some((entry) => entry.path === 'only-external.md'), false);
  } finally {
    if (inherited.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = inherited.dir;
    if (inherited.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = inherited.tree;
  }
});

test('effective revocation denies the next operation and cannot return stale status entries', native, async (t) => {
  const root = await scratch(t); await repo(root);
  let allowed = false;
  const adapter = new LocalGitStatusAdapter(installation, { authorize: async () => allowed });
  await assert.rejects(bind(adapter, root), { code: 'permission-denied' });
  allowed = true; await bind(adapter, root);
  assert.equal((await adapter.status('project')).state, 'ready');
  allowed = false;
  const denied = await adapter.status('project'); assert.equal(denied.state, 'permission-denied'); assert.deepEqual(denied.entries, []);
});

test('external include/filter/worktree configuration is diagnosed without executing a helper or changing bytes', native, async (t) => {
  const root = await scratch(t); await repo(root);
  const configPath = join(root, '.git/config'), original = await readFile(configPath), adapter = new LocalGitStatusAdapter(installation, host);
  await bind(adapter, root);
  for (const configuration of ['[include]\npath = ../outside.cfg\n', '[filter "unsafe"]\nclean = echo unsafe\n', '[core]\nworktree = ../outside\n']) {
    const bytes = Buffer.concat([original, Buffer.from('\n' + configuration)]); await writeFile(configPath, bytes);
    assert.equal((await adapter.status('project')).state, 'unsupported-repository'); assert.deepEqual(await readFile(configPath), bytes);
  }
});

test('configured fsmonitor is overridden and status never launches it', native, async (t) => {
  const root = await scratch(t); await repo(root);
  await file(root, 'tracked.md'); await git(root, ['add', '--', 'tracked.md']);
  const marker = join(root, 'unexpected-marker'), script = join(root, 'monitor.cmd');
  await file(root, 'monitor.cmd', `@echo off\r\necho unsafe > "${marker}"\r\n`);
  await git(root, ['config', 'core.fsmonitor', script]);
  const adapter = new LocalGitStatusAdapter(installation, host); await bind(adapter, root);
  assert.equal((await adapter.status('project')).state, 'ready'); await assert.rejects(access(marker));
});

test('root replacement and missing root preserve bindings as recoverable states', native, async (t) => {
  const base = await scratch(t), root = join(base, 'project'); await repo(root);
  const adapter = new LocalGitStatusAdapter(installation, host); await bind(adapter, root);
  await rename(root, join(base, 'moved'));
  assert.equal((await adapter.status('project')).state, 'root-unavailable');
  await mkdir(root);
  assert.equal((await adapter.status('project')).state, 'root-changed');
  assert.equal((await readFile(join(base, 'moved/.git/HEAD'), 'utf8')).trim(), 'ref: refs/heads/main');
});

test('junction roots and linked worktree content cannot escape the granted root', native, async (t) => {
  const base = await scratch(t), root = join(base, 'project'), outside = join(base, 'outside');
  await repo(root); await mkdir(outside); await file(outside, 'foreign.md');
  const adapter = new LocalGitStatusAdapter(installation, host);
  const alias = join(base, 'alias'); await symlink(root, alias, 'junction');
  await assert.rejects(bind(adapter, alias), { code: 'root-changed' });
  await bind(adapter, root); await symlink(outside, join(root, 'escape'), 'junction');
  assert.equal((await adapter.status('project')).state, 'unsupported-repository');
  assert.equal(await readFile(join(outside, 'foreign.md'), 'utf8'), 'fixture\n');
});

test('gitfile redirection and object alternates are rejected before Git can follow another repository', native, async (t) => {
  const base = await scratch(t), root = join(base, 'project'); await mkdir(root);
  await file(root, '.git', 'gitdir: ../foreign/.git\n');
  const adapter = new LocalGitStatusAdapter(installation, host); await bind(adapter, root);
  assert.equal((await adapter.status('project')).state, 'unsupported-repository');
  await rm(join(root, '.git')); await repo(root); await file(root, '.git/objects/info/alternates', '../../../foreign/.git/objects\n');
  assert.equal((await adapter.status('project')).state, 'unsupported-repository');
  await rm(join(root, '.git/objects/info/alternates')); await file(root, 'nested/.git', 'gitdir: ../../foreign/.git\n');
  assert.equal((await adapter.status('project')).state, 'unsupported-repository');
});

test('a cancelled status returns no partial success', native, async (t) => {
  const root = await scratch(t); await repo(root);
  const adapter = new LocalGitStatusAdapter(installation, host); await bind(adapter, root);
  const controller = new AbortController(); controller.abort();
  const status = await adapter.status('project', controller.signal);
  assert.equal(status.state, 'cancelled'); assert.deepEqual(status.entries, []);
});

test('a config change at the command boundary discards the observation without rewriting external bytes', native, async (t) => {
  const root = await scratch(t); await repo(root);
  let checks = 0;
  const configPath = join(root, '.git/config'), changed = Buffer.concat([await readFile(configPath), Buffer.from('\n# external edit\n')]);
  const adapter = new LocalGitStatusAdapter(installation, { authorize: async () => { if (++checks === 3) await writeFile(configPath, changed); return true; } });
  await bind(adapter, root);
  const status = await adapter.status('project');
  assert.equal(status.state, 'root-changed'); assert.deepEqual(status.entries, []); assert.deepEqual(await readFile(configPath), changed);
});

test('unbind during authorization invalidates the in-flight repository context', native, async (t) => {
  const root = await scratch(t); await repo(root);
  let checks = 0;
  const adapter = new LocalGitStatusAdapter(installation, { authorize: async () => { if (++checks === 3) adapter.unbind('project'); return true; } });
  await bind(adapter, root);
  assert.equal((await adapter.status('project')).state, 'permission-denied');
  await assert.rejects(adapter.status('project'), { code: 'repository-not-bound' });
});
