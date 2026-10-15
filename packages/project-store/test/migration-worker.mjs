import { openProjectService } from '../dist/index.js';

const [root, operationId, stopAt] = process.argv.slice(2);
const host = { authenticatedActor: { kind: 'user', id: 'migration-fixture-user' }, domain: { authorize: () => true }, authorizeAccess: () => true };
const migrationSteps = [
  { id: 'fixture.project.0.9.0-to-1.0.0', scope: 'project', fromVersion: '0.9.0', toVersion: '1.0.0', allowedPointers: [], validateInput: (value) => value.formatVersion === '0.9.0' && Number.isSafeInteger(value.revision), transform: (value) => value },
  { id: 'fixture.entity.0.9.0-to-1.0.0', scope: 'entity', fromVersion: '0.9.0', toVersion: '1.0.0', allowedPointers: [], validateInput: (value) => value.schemaVersion === '0.9.0' && typeof value.title === 'string', transform: (value) => value }
];
const opened = await openProjectService(root, { host, migrationSteps, pollMs: 5000, fault: (phase) => {
  if (phase === stopAt) process.exit(86);
} });
if (!opened.ok) process.exit(2);
const result = await opened.value.service.migrateProject(operationId);
if (!result.ok) { process.stderr.write(JSON.stringify(result.diagnostics)); await opened.value.close(); process.exit(3); }
await opened.value.close();
