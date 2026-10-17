import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerProvider, verifyCodexBinary } from '../src/main/codex-app-server.ts';

const executablePath = process.env.A3_CODEX_BIN;
const expectedVersion = process.env.A3_CODEX_VERSION;
const expectedSha256 = process.env.A3_CODEX_SHA256;
if (!executablePath || !expectedVersion || !expectedSha256) {
  throw new Error('Set A3_CODEX_BIN, A3_CODEX_VERSION, and A3_CODEX_SHA256 to run the opt-in local smoke test.');
}

const profileRoot = await mkdtemp(join(tmpdir(), 'a3-codex-app-server-smoke-'));
let provider;
try {
  const binary = await verifyCodexBinary({ executablePath, expectedVersion, expectedSha256 });
  provider = new CodexAppServerProvider({ userDataDirectory: profileRoot, clientVersion: '0.1.0-smoke', binary, handshakeTimeoutMs: 15000 });
  const session = await provider.start();
  if (!session.protocolInitialized) throw new Error('Codex app-server handshake did not complete.');
  console.log(`Codex app-server initialized (${session.artifactVersion}); no thread or turn was started.`);
} finally {
  await provider?.stop().catch(() => undefined);
  await rm(profileRoot, { recursive: true, force: true });
}
