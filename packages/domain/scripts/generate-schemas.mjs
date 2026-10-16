import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';

const schemas = {};
for (const folder of ['e0', 'e1', 'e2']) {
  const root = new URL(`../../../schemas/${folder}/`, import.meta.url);
  for (const name of (await readdir(root)).filter((name) => name.endsWith('.json')).sort()) {
    const schema = JSON.parse(await readFile(new URL(name, root), 'utf8'));
    schemas[`${folder}/${name}`] = schema;
  }
}
const output = new URL('../.generated/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('schemas.ts', output),
  '// Generated from schemas/e0, schemas/e1 and schemas/e2; runtime never reads files.\n' +
  'export const schemas: Record<string, unknown> = ' + JSON.stringify(schemas, null, 2) + ';\n');
