import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseAst } from '@mermaid-js/parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'fixtures/manifest.json'), 'utf8'));
const cases = [
  { file: 'fixtures/mermaid/c4-context.mmd', type: 'c4', label: 'C4 context' },
  { file: 'fixtures/mermaid/class-model.mmd', type: 'class', label: 'class diagram' },
];
const outputs = path.join(root, 'outputs/mermaid');
await mkdir(outputs, { recursive: true });
const results = [];

for (const item of cases) {
  const bytes = await readFile(path.join(root, item.file));
  const source = bytes.toString('utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (manifest.files[item.file]?.sha256 !== hash) throw new Error(`source changed: ${item.file}`);
  let ast;
  let astResult;
  try {
    ast = await parseAst(item.type, source);
    astResult = { supported: true, ast };
  } catch (error) {
    if (!String(error?.message).includes('Unknown diagram type')) throw error;
    astResult = { supported: false, reason: String(error.message) };
  }
  const outputPath = path.join(outputs, `${path.basename(item.file, '.mmd')}.ast-capability.json`);
  await writeFile(outputPath, `${JSON.stringify(astResult, null, 2)}\n`, 'utf8');
  const after = await readFile(path.join(root, item.file));
  if (!after.equals(bytes)) throw new Error(`source was modified: ${item.file}`);
  results.push({ file: item.file, diagram: item.label, parserType: item.type, sha256: hash, astPath: path.relative(root, outputPath).replaceAll('\\', '/'), ...astResult });
}

console.log(JSON.stringify({ ok: true, parser: '@mermaid-js/parser 2.0.1', results }, null, 2));
