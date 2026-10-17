const protectedPatterns = ['.git', '.env', '.env.*', 'credentials', 'credentials.*', 'credential', 'credential.*',
  'secret', 'secret.*', 'secrets', 'secrets.*', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub',
  '*.pem', '*.key', '*.p12', '*.pfx', 'node_modules', '.cache', 'cache', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.venv', 'venv', 'dist', 'build', 'out', 'target', 'coverage', 'codex-authorization'];
export const GIT_STATUS_EXCLUSIONS: readonly string[] = Object.freeze([
  ':(exclude,glob,icase)**/.a3/local', ':(exclude,glob,icase)**/.a3/local/**',
  ...protectedPatterns.flatMap((pattern) => [`:(exclude,glob,icase)**/${pattern}`, `:(exclude,glob,icase)**/${pattern}/**`])
]);
const protectedName = /^(?:\.git|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|node_modules|\.?cache|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|dist|build|out|target|coverage|codex-authorization)$/i;
export function validGitRelativePath(path: string): boolean {
  return !!path && !path.startsWith('/') && !/[\\:\0]/.test(path) && path.split('/').every((part) => part !== '.' && part !== '..' && !!part);
}
export function protectedGitPath(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  return parts.some((part, index) => protectedName.test(part) || part === 'local' && parts[index - 1] === '.a3');
}
