import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProjectCapabilityBroker } from '../dist/index.js';

export const fixtureRoot = fileURLToPath(new URL('../../../fixtures/e0/project/', import.meta.url));
export const E1 = '00000000-0000-4000-8000-000000000002';
export const W1 = '00000000-0000-4000-8000-000000000006';
export const P1 = '00000000-0000-4000-8000-000000000008';
export const entityPath = `.a3/entities/${E1}.json`;
export const id = (n) => '80000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
export async function entity() { return JSON.parse(await readFile(join(fixtureRoot, entityPath), 'utf8')); }
export const location = { kind: 'entity', path: entityPath, expectedId: E1 };
export async function scratch(t) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'a3-store-test-'));
  const root = join(tempRoot, 'project');
  await cp(fixtureRoot, root, { recursive: true });
  t.after(async () => {
    const target = resolve(tempRoot);
    const rel = relative(resolve(tmpdir()), target);
    if (isAbsolute(rel) || rel === '' || rel === '..' || rel.startsWith('..' + sep) || !basename(target).startsWith('a3-store-test-')) throw new Error('Unsafe cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  return { root, tempRoot };
}
export async function fixtureHost(root, actorId = 'test-user', profile = 'trabajar', confirmation = () => true) {
  const actor = { kind: 'user', id: actorId };
  const project = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const capabilities = createProjectCapabilityBroker({ stateDirectory: join(resolve(root, '..'), 'a3-host-data'), authenticatedActor: actor, confirmUserAction: confirmation });
  await capabilities.setProfile({ root, projectId: project.projectId, profile });
  return { authenticatedActor: actor, capabilities, projectId: project.projectId };
}
