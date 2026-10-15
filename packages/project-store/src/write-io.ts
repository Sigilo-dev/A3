import { link, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkedPath, PathError, resolvePortablePath } from './reader.js';

export async function ensureDirectories(root: string, path: string): Promise<void> {
  resolvePortablePath(root, path);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    try { await checkedPath(root, folder, 'directory'); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      if (i > 1) await checkedPath(root, parts.slice(0, i - 1).join('/'), 'directory');
      try { await mkdir(resolvePortablePath(root, folder)); }
      catch (race) { if (!(race && typeof race === 'object' && 'code' in race && race.code === 'EEXIST')) throw race; }
      await checkedPath(root, folder, 'directory');
    }
  }
}
export async function absentPath(root: string, path: string): Promise<string> {
  const target = resolvePortablePath(root, path);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
  if (parent) await checkedPath(root, parent, 'directory');
  try { await lstat(target); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return target; throw error; }
  throw new PathError('destination-exists', 'El destino existe; no se reemplaza silenciosamente.');
}
export async function writeExclusive(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const target = await absentPath(root, path);
  const handle = await open(target, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await checkedPath(root, path, 'file');
}
export async function installExclusive(root: string, candidate: string, target: string): Promise<void> {
  const source = await checkedPath(root, candidate, 'file');
  const destination = await absentPath(root, target);
  const [sourceStat, parentStat] = await Promise.all([stat(source, { bigint: true }), stat(await realpath(dirname(destination)), { bigint: true })]);
  if (sourceStat.dev !== parentStat.dev) throw new PathError('different-volume', 'El temporal y destino deben estar en el mismo volumen.');
  // link creates a name; it never overwrites a name won by an external editor.
  await link(source, destination);
}
