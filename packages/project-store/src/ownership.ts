import { createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import { sha256 } from './codec.js';

export async function projectIdentity(root: string): Promise<string> {
  const info = await stat(root, { bigint: true });
  if (!info.isDirectory() || info.ino === 0n) throw new Error('Project directory has no usable file identity');
  return sha256(Buffer.from(`${info.dev}:${info.ino}`));
}
export interface Ownership { alive(): boolean; close(): Promise<void>; }
export async function acquireOwnership(identity: string): Promise<Ownership | undefined> {
  if (process.platform !== 'win32') return undefined;
  const server = createServer((socket) => socket.destroy());
  let alive = false;
  server.on('error', () => { alive = false; });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: `\\\\.\\pipe\\a3-writer-${identity}`, exclusive: true }, () => {
        server.removeListener('error', reject); alive = true; resolve();
      });
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') return undefined;
    throw error;
  }
  return { alive: () => alive && server.listening, close: async () => {
    alive = false;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
