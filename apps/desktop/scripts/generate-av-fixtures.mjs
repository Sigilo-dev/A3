// Synthetic, repository-owned samples. Never takes user/project paths as input.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const expected = '74db6c184a03dba2bdfe23e1a1f41cf5a8385bc1de6a7a1b26db1dc541abef93';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const found = spawnSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)[0];
const executable = await realpath(found); assert.equal(sha(await readFile(executable)), expected);
const root = fileURLToPath(new URL('../../../fixtures/e3/av/', import.meta.url)); await mkdir(root, { recursive: true });
const generate = (args) => { const result = spawnSync(executable, ['-hide_banner', '-loglevel', 'error', ...args], { cwd: root, windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
generate(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-map', '0:v', '-map', '1:a', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-threads', '1', '-y', 'video.mkv']);
generate(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', '-y', 'audio.wav']);
await writeFile(new URL('../../../fixtures/e3/av/invalid.bin', import.meta.url), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0]));
const fixtures = {};
for (const name of ['video.mkv', 'audio.wav', 'invalid.bin']) { const bytes = await readFile(new URL('../../../fixtures/e3/av/' + name, import.meta.url)); fixtures[name] = { sha256: sha(bytes), bytes: bytes.length }; }
await writeFile(new URL('../../../fixtures/e3/av/manifest.json', import.meta.url), JSON.stringify({ schemaVersion: 1, synthetic: true, generator: 'Gyan FFmpeg 8.0.1 full_build Windows x64', executableSha256: expected, fixtures }, null, 2) + '\n');
console.log('Generated synthetic AV fixtures and hashes. Matroska UIDs can vary between regenerations.');
