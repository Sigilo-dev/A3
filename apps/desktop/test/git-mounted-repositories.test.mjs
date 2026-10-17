import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalProjectManager } from '@a3/project-store';
import { fixtureHost, fixtureRoot } from '../../../packages/project-store/test/fixture.mjs';
import { GitProjectController } from '../src/main/git-controller.ts';
import { gitEnvironment, inspectGitInstallation } from '../src/main/git-process.ts';

const installation = await inspectGitInstallation();
const native = { skip: installation.state !== 'available' ? 'Requires the verified optional Windows Git build' : false };
const exec = promisify(execFile);
const author = { name: 'A3 mount test', email: 'a3-mount-test@example.invalid' };
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value; };
const normalizedRoot = (root) => root.replaceAll('\\', '/').toLowerCase();

async function makeRepository(root, branch) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), `${branch} baseline\n`);
  await exec(installation.binary.path, ['init', '--initial-branch=main'], { cwd: root, env: gitEnvironment(root), windowsHide: true });
  await exec(installation.binary.path, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'add', '--', 'README.md'], { cwd: root, env: gitEnvironment(root), windowsHide: true });
  await exec(installation.binary.path, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', 'test: baseline'], { cwd: root, env: gitEnvironment(root), windowsHide: true });
  if (branch !== 'main') await exec(installation.binary.path, ['branch', '-m', branch], { cwd: root, env: gitEnvironment(root), windowsHide: true });
}

test('A3-036 mount context selects the bound repository; commit and Git revocation stay scoped to that mount', native, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'a3-mounted-git ñ ')), root = join(tempRoot, 'a3-project');
  t.after(async () => { await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await cp(fixtureRoot, root, { recursive: true });
  const repoA = join(tempRoot, 'repo alpha'), repoB = join(tempRoot, 'repo beta');
  await makeRepository(repoA, 'main'); await makeRepository(repoB, 'develop');
  const host = await fixtureHost(root, 'e6-c2-mounted-git');
  const mountA = randomUUID(), mountB = randomUUID(), resourceA = randomUUID(), resourceB = randomUUID();
  for (const [mountId, selectedRoot, resourceId] of [[mountA, repoA, resourceA], [mountB, repoB, resourceB]]) {
    assert.equal(await host.capabilities.approveLocalMount({ root, projectId: host.projectId, mountId, selectedRoot, permission: 'read-only' }), true);
    await writeFile(join(root, '.a3', 'resources', `${resourceId}.json`), JSON.stringify({ schemaVersion: '1.0.0', id: resourceId,
      revision: 1, kind: 'mounted-file', mountId, path: 'README.md', extensions: {} }, null, 2) + '\n');
  }
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'host state'), host });
  t.after(() => manager.dispose());
  const sessionId = (await manager.openFolder(root)).active.sessionId;
  const window = { isDestroyed: () => false, webContents: { executeJavaScript: async () => true } };
  const controller = new GitProjectController(manager, host.capabilities, host.authenticatedActor, () => window);
  const mounts = ok(await controller.handle({ action: 'mounts', sessionId }));
  assert.equal(mounts.length, 2);
  assert.equal(normalizedRoot(mounts.find((mount) => mount.mountId === mountA).root), normalizedRoot(repoA));
  assert.equal(normalizedRoot(mounts.find((mount) => mount.mountId === mountB).root), normalizedRoot(repoB));
  for (const mountId of [mountA, mountB]) ok(await controller.handle({ action: 'mount-capability', sessionId, mountId, granted: true }));

  const initialA = ok(await controller.handle({ action: 'load', sessionId, mountId: mountA }));
  const initialB = ok(await controller.handle({ action: 'load', sessionId, mountId: mountB }));
  assert.equal(normalizedRoot(initialA.root), normalizedRoot(repoA)); assert.equal(initialA.status.branch, 'main');
  assert.equal(normalizedRoot(initialB.root), normalizedRoot(repoB)); assert.equal(initialB.status.branch, 'develop');
  const headA = (await exec(installation.binary.path, ['rev-parse', 'HEAD'], { cwd: repoA, env: gitEnvironment(repoA), windowsHide: true })).stdout.trim();
  await writeFile(join(repoA, 'README.md'), 'unselected repo edit\n');
  await writeFile(join(repoB, 'README.md'), 'selected repo edit\n');

  const stage = ok(await controller.handle({ action: 'review', sessionId, mountId: mountB, input: { kind: 'stage', paths: ['README.md'] } }));
  assert.equal(normalizedRoot(stage.root), normalizedRoot(repoB)); assert.equal(stage.branch, 'develop');
  ok(await controller.handle({ action: 'apply', sessionId, mountId: mountB, token: stage.token }));
  const commit = ok(await controller.handle({ action: 'review', sessionId, mountId: mountB, input: {
    kind: 'commit', message: 'feat(test): commit selected mount', name: author.name, email: author.email
  } }));
  assert.equal(normalizedRoot(commit.root), normalizedRoot(repoB));
  ok(await controller.handle({ action: 'apply', sessionId, mountId: mountB, token: commit.token }));
  const latestA = (await exec(installation.binary.path, ['rev-parse', 'HEAD'], { cwd: repoA, env: gitEnvironment(repoA), windowsHide: true })).stdout.trim();
  const latestB = (await exec(installation.binary.path, ['rev-parse', 'HEAD'], { cwd: repoB, env: gitEnvironment(repoB), windowsHide: true })).stdout.trim();
  assert.equal(latestA, headA, 'the unselected repository HEAD is untouched');
  assert.notEqual(latestB, initialB.status.head, 'the selected repository receives the commit');
  assert.equal((await readFile(join(repoA, 'README.md'), 'utf8')), 'unselected repo edit\n');

  ok(await controller.handle({ action: 'mount-capability', sessionId, mountId: mountB, granted: false }));
  const revoked = await controller.handle({ action: 'load', sessionId, mountId: mountB });
  assert.equal(revoked.ok, false); assert.equal(revoked.error.code, 'permission-denied');
  const otherStillAvailable = ok(await controller.handle({ action: 'load', sessionId, mountId: mountA }));
  assert.equal(otherStillAvailable.status.branch, 'main');
});
