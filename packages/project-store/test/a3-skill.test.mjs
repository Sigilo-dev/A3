import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { A3_TOOL_SCHEMAS } from '../dist/index.js';

const skillUrl = new URL('../../../skills/a3/SKILL.md', import.meta.url);
const schemaUrl = new URL('../../../skills/a3/references/a3-tool-schemas.json', import.meta.url);

test('A3-019/A3-022/A3-033: portable A3 skill matches the host schemas and preserves explicit-scope rules', async () => {
  const [skill, schemaText] = await Promise.all([readFile(skillUrl, 'utf8'), readFile(schemaUrl, 'utf8')]);
  assert.deepEqual(JSON.parse(schemaText), A3_TOOL_SCHEMAS, 'portable schemas must stay identical to the host contract');
  for (const tool of Object.keys(A3_TOOL_SCHEMAS)) assert.match(skill, new RegExp(`\\b${tool}\\b`));
  assert.match(skill, /Do not broaden a selection to the complete vault/i);
  assert.match(skill, /not registered with Codex app-server or MCP/i);
  assert.match(skill, /does not paste or send it/i);
  assert.match(skill, /\.a3\/local\/prompt-runs/);
  assert.match(skill, /expected revisions/i);
  assert.match(skill, /effective `document\.edit`/);
});
