import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexTurnCoordinator } from '../../../src/main/codex-turns.ts';
import { digest } from '../../../src/main/codex-turn-state.ts';

// Deliberately exits without close/finally at a synced boundary. No provider, credentials or network.
const [root, phase] = process.argv.slice(2);
const binding = { projectId: '00000000-0000-4000-8000-000000000001', rootIdentity: 'a'.repeat(64) };
const coordinator = await CodexTurnCoordinator.open(root, binding, { fault: async (current) => { if (current === phase) process.exit(91); } });
const sessionId = await coordinator.addSession('thread_fixture', 'session_provider_fixture');
const turnId = await coordinator.trackTurn(sessionId, 'turn_fixture', '00000000-0000-4000-8000-000000000003');
const command = { ...binding, operationId: '00000000-0000-4000-8000-000000000004', actor: { kind: 'agent', id: 'a3-fixture-agent' },
  command: 'a3.core.update-entity', expectedRevisions: [], scope: {}, payload: { title: 'Revisado' } };
await coordinator.runOperation(turnId, command, {
  authorize: async () => true,
  lookup: async () => null,
  execute: async () => {
    const receipt = { projectId: binding.projectId, operationId: command.operationId, requestHash: digest(command), resultHash: digest({ effect: 'one revision' }), revisions: [{ id: binding.projectId, revision: 2 }] };
    const file = await open(join(root, 'fixture-effect-and-receipt.json'), 'wx');
    try { await file.writeFile(JSON.stringify({ effects: 1, receipt })); await file.sync(); } finally { await file.close(); }
    return receipt;
  }
});
throw new Error('The crash fixture did not reach its selected boundary.');
