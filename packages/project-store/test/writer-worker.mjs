import { openProjectService } from '../dist/index.js';
import { fixtureHost } from './fixture.mjs';
const [root, mode, phase] = process.argv.slice(2);
const host = await fixtureHost(root, 'test-user');
const result = await openProjectService(root, { host, pollMs: 5000, fault: (point) => {
  if (point === phase) process.exit(86);
} });
if (!result.ok) { process.send?.({ error: result.diagnostics }); process.exit(2); }
const lease = result.value;
if (mode === 'probe') {
  process.send?.({ mode: lease.service.state.mode, reason: lease.service.state.reason });
  await lease.close(); process.exit(0);
}
if (mode === 'hold') {
  process.send?.({ mode: lease.service.state.mode });
  process.on('message', async () => { await lease.close(); process.exit(0); });
} else if (mode === 'recover') {
  process.send?.({ mode: lease.service.state.mode, reason: lease.service.state.reason, diagnostics: lease.service.state.recoveryDiagnostics });
  await lease.close(); process.exit(0);
} else {
  const resource = lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const opened = await lease.service.openResource(resource.value.id);
  const plan = await lease.service.prepareResourceWrite({ operationId: '70000000-0000-4000-8000-000000000001', resourceId: resource.value.id,
    expectedRevision: opened.value.revision, expectedHash: opened.value.sha256, bytes: Buffer.from('new worker content\r\n') });
  if (!plan.ok) { process.send?.({ error: plan.diagnostics }); process.exit(3); }
  const committed = await lease.service.commit(plan.value);
  process.send?.({ committed }); await lease.close(); process.exit(committed.ok ? 0 : 4);
}
