import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A3_TOOL_SCHEMAS } from '../dist/agent-tools.js';

const target = new URL('../../../skills/a3/references/a3-tool-schemas.json', import.meta.url);
await mkdir(dirname(fileURLToPath(target)), { recursive: true });
await writeFile(target, `${JSON.stringify(A3_TOOL_SCHEMAS, null, 2)}\n`, 'utf8');
