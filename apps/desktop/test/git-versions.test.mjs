import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { openProjectService } from '@a3/project-store';
import { fixtureHost } from '../../../packages/project-store/test/fixture.mjs';
import { inspectGitInstallation, gitEnvironment } from '../src/main/git-process.ts';
import { LocalGitVersions } from '../src/main/git-versions.ts';
import { validGitRequest } from '../src/shared/git-operations.ts';

const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e6/git/versions.json', import.meta.url), 'utf8'));
const installation = await inspectGitInstallation(), native = { skip: installation.state !== 'available' ? 'Requires the verified optional Windows Git build' : false };
const exec = promisify(execFile), hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function context(t, project = false, fault) {
  const base = await mkdtemp(join(tmpdir(), 'a3 git review ñ ')), root = join(base, 'project with spaces'); let lease;
  t.after(async () => { await lease?.close(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await mkdir(root); if (project) await cp(new URL('../../../fixtures/e0/project', import.meta.url), root, { recursive: true });
  const git = async (...args) => (await exec(installation.binary.path, ['-c', `user.name=${fixture.author.name}`, '-c', `user.email=${fixture.author.email}`, ...args], { cwd: root, env: gitEnvironment(root), windowsHide: true, encoding: 'utf8' })).stdout;
  const file = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
  await file('.gitignore', '.a3/local/\n.env*\n.cache/\n'); await file('notes.md', Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n') + '\n'); await file('other.md', 'other original\n');
  await git('init', '--initial-branch=main'); await git('add', '--', '.'); await git('commit', '-m', 'test: baseline');
  const projectId = project ? JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8')).projectId : randomUUID();
  let dirty = false, allowed = true, host;
  if (project) {
    host = await fixtureHost(root);
    const opened = await openProjectService(root, { host, pollMs: 60000, fault }); assert.equal(opened.ok, true); lease = opened.value;
  }
  const service = await LocalGitVersions.open(installation, { repositoryId: 'project', projectId, kind: 'a3-project', root }, {
    authorize: async (cap, stage) => allowed && (host ? (await host.capabilities.authorizeCapabilities(root, host.authenticatedActor, projectId, ['project.read', cap], cap, stage)).allowed : true),
    hasDirtyBuffers: async () => dirty,
    prepareRestore: async (operationId, files) => {
      assert.ok(lease, 'Restoration must use the real project store');
      const plan = await lease.service.prepareVersionRestore({ operationId, files }); assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
      return { paths: plan.value.changes.map((change) => change.path), images: plan.value.changes.map((change) => ({ path: change.path, bytes: plan.value.proposedBytes(change.path) })), snapshotId: plan.value.operationId,
        apply: async () => { const applied = await lease.service.commit(plan.value); if (!applied.ok) throw Object.assign(new Error('restore refused'), { code: 'RESTORE_CONFLICT' }); } };
    }
  });
  return { root, base, git, file, service, setDirty: (value) => { dirty = value; }, setAllowed: (value) => { allowed = value; }, get lease() { return lease; },
    restart: async () => { await lease.close(); const opened = await openProjectService(root, { host, pollMs: 60000 }); assert.equal(opened.ok, true); lease = opened.value; } };
}

test('Git IPC rejects arbitrary commands, roots, tokens and oversized input', () => {
  const sessionId = randomUUID();
  for (const input of [null, { action: 'load', sessionId, root: 'C:/other' }, { action: 'review', sessionId, input: { kind: 'shell', message: 'whoami' } },
    { action: 'review', sessionId, input: { kind: 'stage', paths: ['x'], root: '../' } }, { action: 'apply', sessionId, token: 'forged' }]) assert.equal(validGitRequest(input), false);
  assert.equal(validGitRequest({ action: 'review', sessionId, input: { kind: 'stage', paths: ['notes.md'] } }), true);
});

test('A3-034: reviewed hunk stage is partial, commit uses only reviewed index, explicit branch leaves HEAD unchanged', native, async (t) => {
  const c = await context(t), changed = Array.from({ length: 40 }, (_, index) => index === 2 || index === 33 ? `changed ${index}` : `line ${index}`).join('\n') + '\n';
  await c.file('notes.md', changed); await c.file('other.md', 'unselected change\n');
  const review = await c.service.review({ kind: 'stage', paths: ['notes.md'] });
  assert.equal(review.root, c.root); assert.equal(review.diffs[0].hunks.length, 2);
  const indexBefore = await readFile(join(c.root, '.git/index'));
  await assert.rejects(c.service.apply(review.token, ['0'.repeat(64), '1'.repeat(64)]), { code: 'invalid-hunks' });
  assert.deepEqual(await readFile(join(c.root, '.git/index')), indexBefore);
  await c.service.apply(review.token, [review.diffs[0].hunks[0].id]);
  const staged = await c.git('show', ':notes.md'); assert.match(staged, /changed 2/); assert.match(staged, /line 33/); assert.doesNotMatch(staged, /changed 33/);
  assert.equal(await c.git('diff', '--cached', '--name-only'), 'notes.md\n'); assert.equal(await readFile(join(c.root, 'notes.md'), 'utf8'), changed);
  await c.file('.git/hooks/reference-transaction', '#!/bin/sh\necho unsafe > unexpected-hook\n'); await c.file('.git/hooks/pre-commit', '#!/bin/sh\necho unsafe > unexpected-hook\n');
  const commit = await c.service.review({ kind: 'commit', message: fixture.message, ...fixture.author });
  assert.deepEqual(commit.paths, ['notes.md']); assert.match(commit.diffs[0].text, /changed 2/); assert.doesNotMatch(commit.diffs[0].text, /changed 33/);
  const result = await c.service.apply(commit.token); assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.equal(await c.git('show', 'HEAD:notes.md'), staged); assert.equal((await c.git('log', '-1', '--format=%s')).trim(), fixture.message);
  await assert.rejects(access(join(c.root, 'unexpected-hook')));
  const branch = await c.service.review({ kind: 'branch', branch: fixture.branch }); await c.service.apply(branch.token);
  assert.equal((await c.git('symbolic-ref', '--short', 'HEAD')).trim(), 'main'); assert.equal((await c.git('rev-parse', fixture.branch)).trim(), result.commit);
  assert.equal((await c.service.load()).branches.some((entry) => entry.name === fixture.branch), true);
  await assert.rejects(c.service.apply(commit.token), { code: 'review-expired' });
});

test('index or source changes after review produce a conflict without clobbering the external index', native, async (t) => {
  const c = await context(t); await c.file('notes.md', 'change\n');
  let review = await c.service.review({ kind: 'stage', paths: ['notes.md'] });
  await c.file('other.md', 'external staged\n'); await c.git('add', '--', 'other.md'); const externalIndex = await readFile(join(c.root, '.git/index'));
  await assert.rejects(c.service.apply(review.token), { code: 'review-conflict' }); assert.deepEqual(await readFile(join(c.root, '.git/index')), externalIndex);
  review = await c.service.review({ kind: 'stage', paths: ['notes.md'] }); await c.file('notes.md', 'new external bytes\n');
  await assert.rejects(c.service.apply(review.token), { code: 'review-conflict' }); assert.equal(await readFile(join(c.root, 'notes.md'), 'utf8'), 'new external bytes\n');
  const commit = await c.service.review({ kind: 'commit', message: fixture.message, ...fixture.author });
  await c.git('commit', '-m', 'test: external commit'); const externalHead = await c.git('rev-parse', 'HEAD');
  await assert.rejects(c.service.apply(commit.token), { code: 'review-conflict' }); assert.equal(await c.git('rev-parse', 'HEAD'), externalHead);
});

test('secrets, protected tracked files, LFS attributes, dirty buffers and revoked permissions fail closed', native, async (t) => {
  const c = await context(t);
  await c.file('.env', 'placeholder'); await assert.rejects(c.service.review({ kind: 'stage', paths: ['.env'] }), { code: 'protected-path' });
  await c.file('notes.md', 'api_key = synthetic-private-value\n'); await assert.rejects(c.service.review({ kind: 'stage', paths: ['notes.md'] }), { code: 'secret-detected' });
  await c.file('notes.md', 'safe\n'); await c.file('.gitattributes', '*.md filter=lfs\n');
  await assert.rejects(c.service.review({ kind: 'stage', paths: ['notes.md'] }), { code: 'lfs-or-filter-unavailable' }); await rm(join(c.root, '.gitattributes'));
  await c.file('.git/info/attributes', '*.md filter=lfs\n');
  await assert.rejects(c.service.review({ kind: 'stage', paths: ['notes.md'] }), { code: 'lfs-or-filter-unavailable' }); await rm(join(c.root, '.git/info/attributes'));
  c.setDirty(true); await assert.rejects(c.service.review({ kind: 'stage', paths: ['notes.md'] }), { code: 'unsaved-changes' }); c.setDirty(false);
  const review = await c.service.review({ kind: 'stage', paths: ['notes.md'] }); c.setAllowed(false); await assert.rejects(c.service.apply(review.token), { code: 'permission-denied' }); c.setAllowed(true);
  await c.git('add', '-f', '--', '.env'); await assert.rejects(c.service.review({ kind: 'commit', message: fixture.message, ...fixture.author }), { code: 'protected-tracked-files' });
});

test('unstage and cancellation preserve working bytes; existing index.lock is never removed', native, async (t) => {
  const c = await context(t); await c.file('notes.md', 'changed\n');
  await assert.rejects(c.service.review({ kind: 'stage', paths: ['missing-directory'] }), { code: 'invalid-selection' });
  const stage = await c.service.review({ kind: 'stage', paths: ['notes.md'] }); c.service.cancel(stage.token);
  await assert.rejects(c.service.apply(stage.token), { code: 'review-expired' });
  const again = await c.service.review({ kind: 'stage', paths: ['notes.md'] }); await c.service.apply(again.token);
  const unstage = await c.service.review({ kind: 'unstage', paths: ['notes.md'] }); await c.service.apply(unstage.token);
  assert.equal(await c.git('diff', '--cached', '--name-only'), ''); assert.equal(await readFile(join(c.root, 'notes.md'), 'utf8'), 'changed\n');
  const blocked = await c.service.review({ kind: 'stage', paths: ['notes.md'] }); await c.file('.git/index.lock', 'external lock');
  await assert.rejects(c.service.apply(blocked.token), { code: 'repository-busy' }); assert.equal(await readFile(join(c.root, '.git/index.lock'), 'utf8'), 'external lock');
});

test('real Git merge conflict preserves both index and conflict source', native, async (t) => {
  const c = await context(t); await c.git('checkout', '-b', 'other'); await c.file('other.md', 'other branch\n'); await c.git('add', '--', 'other.md'); await c.git('commit', '-m', 'test: other');
  await c.git('checkout', 'main'); await c.file('other.md', 'main branch\n'); await c.git('add', '--', 'other.md'); await c.git('commit', '-m', 'test: main');
  await assert.rejects(c.git('merge', 'other')); const index = await readFile(join(c.root, '.git/index')), source = await readFile(join(c.root, 'other.md'));
  await assert.rejects(c.service.review({ kind: 'restore', paths: ['other.md'] }), { code: 'operation-in-progress' });
  assert.deepEqual(await readFile(join(c.root, '.git/index')), index); assert.deepEqual(await readFile(join(c.root, 'other.md')), source);
});

test('A3-034 restore uses E1 journal/snapshot, preserves resource ID, increments revision and offers a guarded return', native, async (t) => {
  const c = await context(t, true), source = join(c.root, fixture.sourcePath), original = await readFile(source), changed = Buffer.from('Reviewed current document ñ\n');
  const prepared = await c.lease.service.prepareResourceWrite({ operationId: randomUUID(), resourceId: fixture.resourceId, expectedRevision: 1, expectedHash: hash(original), bytes: changed }); assert.equal(prepared.ok, true);
  assert.equal((await c.lease.service.commit(prepared.value)).ok, true);
  const index = await readFile(join(c.root, '.git/index')), outside = join(c.base, 'external.txt'); await writeFile(outside, 'foreign');
  const review = await c.service.review({ kind: 'restore', paths: [fixture.sourcePath] });
  assert.equal(review.paths.some((path) => path.endsWith(fixture.resourceId + '.json')), true);
  assert.match(review.diffs[0].text, /Reviewed current document/);
  const applied = await c.service.apply(review.token); assert.ok(applied.snapshotId && applied.undoToken);
  assert.deepEqual(await readFile(source), original); assert.deepEqual(await readFile(join(c.root, '.git/index')), index); assert.equal(await readFile(outside, 'utf8'), 'foreign');
  const descriptor = JSON.parse(await readFile(join(c.root, '.a3/resources', fixture.resourceId + '.json'), 'utf8')); assert.equal(descriptor.id, fixture.resourceId); assert.equal(descriptor.revision, 3);
  await access(join(c.root, '.a3/local/recovery/snapshots', applied.snapshotId, 'snapshot.json'));
  const back = await c.service.review({ kind: 'undo-restore', undoToken: applied.undoToken }); await c.service.apply(back.token);
  assert.deepEqual(await readFile(source), changed); assert.equal(JSON.parse(await readFile(join(c.root, '.a3/resources', fixture.resourceId + '.json'), 'utf8')).revision, 4);
  assert.equal(c.lease.service.state.project.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), false);
});

test('A3-038 Git history includes commit dates and restores a complete reviewed version through E1', native, async (t) => {
  const c = await context(t, true), notes = join(c.root, 'notes.md'), original = await readFile(notes);
  await c.file('notes.md', 'an uncommitted edit\n');
  const history = await c.service.load();
  assert.ok(history.log[0].date && !Number.isNaN(Date.parse(history.log[0].date)));
  assert.ok(history.status.entries.some((entry) => entry.path === 'notes.md'), 'uncommitted worktree changes remain separate from commits');
  const review = await c.service.review({ kind: 'restore-commit', commit: history.log[0].oid });
  assert.equal(review.targetCommit, history.log[0].oid);
  assert.ok(review.paths.includes('notes.md'));
  assert.match(review.diffs.find((diff) => diff.path === 'notes.md').text, /an uncommitted edit/);
  const applied = await c.service.apply(review.token);
  assert.ok(applied.snapshotId);
  assert.deepEqual(await readFile(notes), original);
  const snapshots = await c.lease.service.listSnapshots(); assert.equal(snapshots.ok, true);
  assert.ok(snapshots.value.some((snapshot) => snapshot.snapshotId === applied.snapshotId && snapshot.reason === 'restore'));
  assert.ok(await readFile(join(c.root, '.a3/local/recovery/snapshots', applied.snapshotId, 'snapshot.json')));
});

test('restore rejects later external bytes and invalid canonical JSON while retaining source and index', native, async (t) => {
  const c = await context(t, true), source = join(c.root, 'other.md'); await c.file('other.md', 'current\n');
  const review = await c.service.review({ kind: 'restore', paths: ['other.md'] }); await c.file('other.md', 'later external\n');
  await assert.rejects(c.service.apply(review.token), { code: 'review-conflict' }); assert.equal(await readFile(source, 'utf8'), 'later external\n');
  const path = '.a3/entities/00000000-0000-4000-8000-000000000002.json', before = await readFile(join(c.root, path));
  const invalid = await c.lease.service.prepareVersionRestore({ operationId: randomUUID(), files: [{ path, expectedHash: hash(before), bytes: Buffer.from('{invalid') }] }); assert.equal(invalid.ok, false); assert.deepEqual(await readFile(join(c.root, path)), before);
});

test('an interrupted Git restore recovers through the existing journal into a valid project', native, async (t) => {
  let crash = false;
  const c = await context(t, true, (phase) => { if (crash && phase === 'after-install') { crash = false; throw new Error('injected interruption'); } });
  await c.file('other.md', 'before restore\n'); const review = await c.service.review({ kind: 'restore', paths: ['other.md'] }); crash = true;
  await assert.rejects(c.service.apply(review.token)); await c.restart();
  assert.equal(c.lease.service.state.project.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), false);
  assert.ok(['before restore\n', 'other original\n'].includes(await readFile(join(c.root, 'other.md'), 'utf8')));
});
