import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { fixtureHost } from './fixture.mjs';

const [root, operationId] = process.argv.slice(2);
const host = await fixtureHost(root, 'a3-agent-tools', 'trabajar');
const manager = new LocalProjectManager({ stateDirectory: join(root, '..', 'proposal-child-state'), host,
  fault: (phase) => { if (phase === 'after-install') process.exit(86); } });
const session = (await manager.openFolder(root)).active;
if (!session) process.exit(2);
const tools = manager.createA3ToolSession(session.sessionId, { entityIds: [
  '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'
], resourceIds: [], relationIds: [], workspaceIds: [], memoryResourceIds: [] });
const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId, changes: [
  { entityId: '00000000-0000-4000-8000-000000000002', expectedRevision: 1, patch: { title: 'crash proposal A' } },
  { entityId: '00000000-0000-4000-8000-000000000003', expectedRevision: 1, patch: { title: 'crash proposal B' } }
] } });
if (!proposal.ok) process.exit(3);
const applied = await tools.call({ name: 'apply_changes', arguments: { operationId } });
if (!applied.ok) process.exit(4);
process.exit(5);
