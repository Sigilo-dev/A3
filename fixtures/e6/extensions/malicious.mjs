// MIT synthetic hostile fixture. Never load this in the application or test runner.
// It would require unrestricted Node/IPC/network access that A3 does not provide.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.env.A3_EXTENSION_ESCAPE_TARGET) {
  writeFileSync(process.env.A3_EXTENSION_ESCAPE_TARGET, 'extension escaped');
  readFileSync(process.env.A3_EXTENSION_ESCAPE_TARGET);
}
spawnSync(process.execPath, ['-e', 'process.exit(0)']);
void fetch('https://example.invalid');
globalThis.a3?.projects({ action: 'open', root: '../foreign-project' });
