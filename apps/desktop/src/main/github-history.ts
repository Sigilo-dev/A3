import { createHash } from 'node:crypto';
import { protectedGitPath, validGitRelativePath } from './git-status-policy.ts';
import { secretLike } from './git-process.ts';
import { githubNeed } from './github-api.ts';
/** Validates the entire reachable object graph, including deleted historical content. */
export function inspectPublishingHistory(bytes: Buffer, oids: readonly string[], head: string): { files: { path: string; bytes: number }[]; bytes: number; objects: number } {
  const objects = new Map<string, { kind: string; bytes: Buffer }>(); let cursor = 0;
  for (const expected of oids) {
    const end = bytes.indexOf(10, cursor); githubNeed(end >= cursor, 'invalid-history');
    const match = /^([a-f0-9]{40}) (blob|tree|commit) (\d+)$/.exec(bytes.subarray(cursor, end).toString('ascii')); githubNeed(match && match[1] === expected, 'invalid-history');
    const size = Number(match![3]); cursor = end + 1; githubNeed(size <= 8 * 1024 * 1024 && cursor + size < bytes.length && bytes[cursor + size] === 10, 'history-limit');
    const content = bytes.subarray(cursor, cursor + size); cursor += size + 1;
    githubNeed(createHash('sha1').update(`${match![2]} ${size}\0`).update(content).digest('hex') === expected, 'invalid-history');
    if (match![2] !== 'tree') githubNeed(!secretLike(content.toString('utf8')) && !content.toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'), 'history-secret-or-lfs');
    objects.set(expected, { kind: match![2]!, bytes: content });
  }
  githubNeed(cursor === bytes.length && objects.get(head)?.kind === 'commit', 'invalid-history');
  const files: { path: string; bytes: number }[] = []; let visited = 0;
  const walk = (oid: string, prefix: string, current: boolean, depth = 0): void => {
    githubNeed(depth < 64 && ++visited <= 50000, 'history-limit');
    const tree = objects.get(oid); githubNeed(tree?.kind === 'tree', 'invalid-history'); let index = 0;
    while (index < tree!.bytes.length) {
      githubNeed(++visited <= 50000, 'history-limit');
      const space = tree!.bytes.indexOf(32, index), zero = tree!.bytes.indexOf(0, space); githubNeed(space > index && zero > space && zero + 21 <= tree!.bytes.length, 'invalid-history');
      const mode = tree!.bytes.subarray(index, space).toString('ascii'), name = new TextDecoder('utf8', { fatal: true }).decode(tree!.bytes.subarray(space + 1, zero));
      const path = prefix + name, target = tree!.bytes.subarray(zero + 1, zero + 21).toString('hex'); index = zero + 21;
      githubNeed(validGitRelativePath(path) && !protectedGitPath(path) && !name.includes('/') && !/[\x00-\x1f]/.test(name), 'protected-history');
      githubNeed(!secretLike(path), 'history-secret-or-lfs');
      if (mode === '40000') walk(target, path + '/', current, depth + 1);
      else { githubNeed(['100644', '100755'].includes(mode) && objects.get(target)?.kind === 'blob', 'unsupported-history'); if (current) files.push({ path, bytes: objects.get(target)!.bytes.length }); }
    }
  };
  for (const [oid, object] of objects) if (object.kind === 'commit') {
    const tree = /^tree ([a-f0-9]{40})\n/.exec(object.bytes.toString('utf8')); githubNeed(tree, 'invalid-history'); walk(tree![1]!, '', oid === head);
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), bytes: [...objects.values()].reduce((sum, object) => sum + object.bytes.length, 0), objects: objects.size };
}
