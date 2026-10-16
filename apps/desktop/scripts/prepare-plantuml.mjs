import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '1.2026.8';
const filename = `plantuml-mit-${version}.jar`;
const sha256 = '3629c9cd017c7f73e6450396eea0040216c7e1eef8473ce33cc1aad469dab2f9';
const url = `https://github.com/plantuml/plantuml/releases/download/v${version}/${filename}`;
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destinationDirectory = join(appDirectory, 'resources', 'plantuml');
const destination = join(destinationDirectory, filename);
const spikeCache = resolve(appDirectory, '..', '..', 'experiments', 'e0', 'diagram-engines', '.cache', filename);
const maximumBytes = 24 * 1024 * 1024;

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function verified(path) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0 || info.size > maximumBytes) return undefined;
  const bytes = await readFile(path);
  return digest(bytes) === sha256 ? bytes : undefined;
}

async function readBounded(response) {
  if (!response.body) throw new Error('PlantUML download did not provide a body.');
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('PlantUML artifact exceeds the 24 MiB build-time download limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

await mkdir(destinationDirectory, { recursive: true });
if (await verified(destination)) {
  process.stdout.write(`PlantUML ${version} already staged and SHA-256 verified.\n`);
  process.exit(0);
}

let bytes = await verified(spikeCache);
if (!bytes) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'A3-build-dependency-fetcher' } });
  const finalHost = new URL(response.url).hostname.toLowerCase();
  if (!response.ok || !['github.com', 'release-assets.githubusercontent.com'].includes(finalHost)) throw new Error(`Official PlantUML download failed (${response.status || 'bad redirect'}).`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximumBytes) throw new Error('PlantUML artifact exceeds the 24 MiB build-time download limit.');
  bytes = await readBounded(response);
}
if (!bytes.length || bytes.length > maximumBytes || digest(bytes) !== sha256) throw new Error('PlantUML artifact failed its pinned SHA-256 check.');

const temporary = `${destination}.${process.pid}.tmp`;
try {
  await writeFile(temporary, bytes, { flag: 'wx' });
  const staged = await verified(temporary);
  if (!staged) throw new Error('Staged PlantUML artifact failed verification.');
  try { await rename(temporary, destination); }
  catch (error) {
    if (await verified(destination)) { await rm(temporary, { force: true }); }
    else throw error;
  }
} finally { await rm(temporary, { force: true }).catch(() => undefined); }

process.stdout.write(`Staged official PlantUML ${version} MIT artifact (${bytes.length} bytes), SHA-256 ${sha256}.\n`);
