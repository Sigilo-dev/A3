import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitAutomationStore, resumeGitAutomationPush, runGitAutomationBatch, validateGitAutomationPolicy } from '../src/main/git-automation.ts';
import { OfficialGithubApi } from '../src/main/github-api.ts';

const oid = 'a'.repeat(40), path = 'notes/plan.md';
const policy = (pushAfterCommit = false) => validateGitAutomationPolicy({ schemaVersion: '1.0.0', mode: 'auto-after-idle', idleMs: 30_000,
  branch: 'main', paths: [path], messageTemplate: 'chore: update {count} files', authorName: 'A3 fixture', authorEmail: 'a3@example.invalid', pushAfterCommit,
  ...(pushAfterCommit ? { destinationUrl: 'https://github.com/sigilo-dev/a3.git' } : {}) });
const view = (entries = [{ path, index: '.', worktree: 'M', kind: 'tracked' }], head = oid) => ({ root: 'fixture', status: { repositoryId: 'project', kind: 'a3-project', state: 'ready', branch: 'main', head,
  entries, excludedTrackedCount: 0, diagnostics: [] }, branches: [], log: [] });
function fakeGit({ current = view(), message = '', failCommit = false } = {}) {
  const calls = { load: 0, fingerprint: 0, review: 0, apply: 0, commits: 0, cancelled: 0 };
  return { calls, load: async () => { calls.load++; return typeof current === 'function' ? current() : current; }, fingerprint: async () => { calls.fingerprint++; return 'b'.repeat(64); },
    review: async (input) => { calls.review++; return { token: `review-${input.kind}`, root: 'fixture', kind: input.kind, branch: 'main', paths: [path], diffs: [{ path, text: `diff ${input.kind}`, binary: false, hunks: [] }], warnings: [] }; },
    apply: async (token) => { calls.apply++; if (token === 'review-stage') return { applied: true, kind: 'stage' }; calls.commits++; if (failCommit) throw Object.assign(new Error('fixture commit failure'), { code: 'review-conflict' }); return { applied: true, kind: 'commit', commit: 'c'.repeat(40) }; },
    cancel: async () => { calls.cancelled++; }, commitMessage: async () => message };
}
const capabilities = { stage: true, commit: true, push: true };

test('A3-037 denies automatic push before staging when the separate push capability is missing', async () => {
  const git = fakeGit();
  const result = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(true), git, pushAvailable: true,
    capabilities: { ...capabilities, push: false }, now: 1000 });
  assert.equal(result.run.state, 'blocked'); assert.equal(result.run.code, 'push-permission-denied');
  assert.equal(git.calls.load, 0); assert.equal(git.calls.review, 0); assert.equal(git.calls.commits, 0);
});

test('A3-037 stops on an unresolved repository conflict without staging or committing', async () => {
  const git = fakeGit({ current: view([{ path, index: 'U', worktree: 'U', kind: 'unmerged' }]) });
  const first = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(), git, pushAvailable: false, capabilities, now: 1000 });
  const result = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(), stored: first.record, git, pushAvailable: false, capabilities, now: 31_000 });
  assert.equal(result.run.state, 'blocked'); assert.equal(result.run.code, 'unresolved-conflict');
  assert.equal(git.calls.review, 0); assert.equal(git.calls.commits, 0);
});

test('A3-037 expired GitHub authorization blocks before creating a local commit', async () => {
  const git = fakeGit(), publisher = { check: async () => { throw Object.assign(new Error('expired'), { code: 'authorization-expired' }); }, publish: async () => assert.fail('must not push') };
  const first = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(true), git, publisher, pushAvailable: true, capabilities, now: 1000 });
  const result = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(true), stored: first.record, git, publisher, pushAvailable: true, capabilities, now: 31_000 });
  assert.equal(result.run.state, 'blocked'); assert.equal(result.run.code, 'authorization-expired');
  assert.equal(git.calls.review, 0); assert.equal(git.calls.commits, 0);
});

test('A3-037 a destination branch that diverged from the local history stops before staging', async () => {
  const git = fakeGit(), publisher = { check: async () => { throw Object.assign(new Error('remote branch diverged'), { code: 'remote-conflict' }); }, publish: async () => assert.fail('must not push') };
  const first = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(true), git, publisher, pushAvailable: true, capabilities, now: 1000 });
  const result = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(true), stored: first.record, git, publisher, pushAvailable: true, capabilities, now: 31_000 });
  assert.equal(result.run.state, 'blocked'); assert.equal(result.run.code, 'remote-conflict');
  assert.equal(git.calls.review, 0); assert.equal(git.calls.commits, 0);
});

test('A3-037 idle commit policy is explicit, presents its diff and remains idempotent after a restart', async () => {
  const git = fakeGit();
  const waiting = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(), git, pushAvailable: false, capabilities, now: 1000 });
  assert.equal(waiting.run.state, 'waiting'); assert.equal(git.calls.review, 0);
  const committed = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(), stored: waiting.record, git, pushAvailable: false, capabilities, now: 31_000,
    persist: async () => {} });
  assert.equal(committed.run.state, 'committed'); assert.equal(committed.run.diffs[0].text, 'diff commit'); assert.equal(git.calls.commits, 1);
  const recoveredGit = fakeGit({ current: view([], 'c'.repeat(40)), message: `chore: update 1 files\n\nA3-Automation-Id: ${waiting.record.runId}` });
  const recovered = await runGitAutomationBatch({ bindingHash: 'd'.repeat(64), policy: policy(), stored: { ...waiting.record, state: 'committing', baseHead: oid,
    message: `chore: update 1 files\n\nA3-Automation-Id: ${waiting.record.runId}` }, git: recoveredGit, pushAvailable: false, capabilities, now: 32_000 });
  assert.equal(recovered.run.state, 'committed'); assert.equal(recovered.run.commit, 'c'.repeat(40)); assert.equal(recoveredGit.calls.commits, 0);
});

test('A3-037 pending push retry publishes only the same recorded commit', async () => {
  const git = fakeGit({ current: view([], 'c'.repeat(40)) }), published = [];
  const publisher = { check: async (_url, _branch, head) => assert.equal(head, 'c'.repeat(40)), publish: async (_url, _branch, head) => { published.push(head); } };
  const pushPolicy = policy(true), policyHash = createHash('sha256').update(JSON.stringify(pushPolicy)).digest('hex');
  const record = { state: 'push-pending', runId: '12345678-1234-4234-8234-123456789012', policyHash, fingerprint: 'b'.repeat(64), baseHead: oid, branch: 'main', paths: [path],
    message: 'chore: update\n\nA3-Automation-Id: 12345678-1234-4234-8234-123456789012', destinationUrl: 'https://github.com/sigilo-dev/a3.git', commit: 'c'.repeat(40), updatedAt: 32_000 };
  const result = await resumeGitAutomationPush({ policy: pushPolicy, record, git, publisher, pushAvailable: true, capabilities: { push: true }, now: 33_000 });
  assert.equal(result.run.state, 'pushed'); assert.deepEqual(published, ['c'.repeat(40)]); assert.equal(git.calls.commits, 0);
  await assert.rejects(resumeGitAutomationPush({ policy: pushPolicy, record: result.record, git, publisher, pushAvailable: true, capabilities: { push: true } }), { code: 'no-pending-push' });
});

test('automation settings default to manual, stay host-local and remain scoped to the repository binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'a3 automation ñ ')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GitAutomationStore(root), first = store.bindingHash('project-one|root-id-one');
  const initial = await store.read(first, 'develop'); assert.equal(initial.policy.mode, 'manual'); assert.equal(initial.policy.idleMs, 300_000); assert.equal(initial.policy.branch, 'develop');
  const configured = validateGitAutomationPolicy({ ...initial.policy, mode: 'auto-after-idle', branch: 'develop', paths: [path], authorName: 'A3', authorEmail: 'a3@example.invalid' });
  await store.write(first, configured);
  const other = await store.read(store.bindingHash('project-two|root-id-two'), 'main'); assert.equal(other.policy.mode, 'manual');
  const stored = await readFile(join(root, 'git-automation', `${first}.json`), 'utf8'); assert.equal(stored.includes(root), false); assert.equal(stored.includes('github_pat_'), false);
  await writeFile(join(root, 'git-automation', `${first}.json`), '{broken'); const damaged = await store.read(first); assert.equal(damaged.corrupt, true);
  assert.equal(await readFile(join(root, 'git-automation', `${first}.json`), 'utf8'), '{broken');
});

test('GitHub automation validates the exact remote branch and recognizes an absent branch', async () => {
  const requests = [], api = new OfficialGithubApi(async (input) => { requests.push(String(input)); return new Response(JSON.stringify({ object: { sha: oid } }), { status: 200 }); });
  assert.equal(await api.branchHead('ghp_synthetic_token_12345678901234567890', 'https://github.com/sigilo-dev/a3.git', 'feature/uno'), oid);
  assert.match(requests[0], /\/git\/ref\/heads\/feature\/uno$/);
  const absent = new OfficialGithubApi(async () => new Response('{}', { status: 404 }));
  assert.equal(await absent.branchHead('ghp_synthetic_token_12345678901234567890', 'https://github.com/sigilo-dev/a3.git', 'main'), null);
  await assert.rejects(absent.branchHead('ghp_synthetic_token_12345678901234567890', 'https://github.com/sigilo-dev/a3.git', '../other'), { code: 'invalid-branch' });
});
