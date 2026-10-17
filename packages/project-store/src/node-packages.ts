import { readdir } from 'node:fs/promises';
import { addDeclarativeNodePackage, declarativeNodePackageFileName, defaultRegistry, validateDeclarativeNodePackage, type DeclarativeNodePackage, type TypeRegistry } from '@a3/domain';
import { issue } from './codec.js';
import { checkedPath, fileBytes, resolvePortablePath } from './reader.js';
import type { StoreDiagnostic } from './types.js';

const maxPackageBytes = 4 * 1024 * 1024;
export interface DeclarativeNodePackageCatalog {
  packages: readonly DeclarativeNodePackage[];
  registry: TypeRegistry;
  diagnostics: readonly StoreDiagnostic[];
  paths: readonly string[];
}
export function nodePackagePath(catalogRoot: string, value: Pick<DeclarativeNodePackage, 'manifest'>): string {
  return `${catalogRoot}/node-packages/${declarativeNodePackageFileName(value)}`;
}

/** Reads only fixed JSON data under the project catalog. No package path or entrypoint is opened. */
export async function readDeclarativeNodePackages(root: string, catalogRoot: string, baseRegistry: TypeRegistry = defaultRegistry()): Promise<DeclarativeNodePackageCatalog> {
  const folder = `${catalogRoot}/node-packages`;
  const packages: DeclarativeNodePackage[] = [], paths: string[] = [], diagnostics: StoreDiagnostic[] = [];
  let registry = JSON.parse(JSON.stringify(baseRegistry)) as TypeRegistry;
  let entries: string[];
  try {
    await checkedPath(root, folder, 'directory');
    entries = (await readdir(resolvePortablePath(root, folder))).filter((name) => name.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { packages, paths, registry, diagnostics };
    const item = issue(folder, 'io', 'node-package-catalog-unavailable', 'No se pudo leer el catálogo declarativo; los tipos personalizados quedan en fallback.', { code: 'IO_FAILED', severity: 'warning' });
    return { packages, paths, registry, diagnostics: [item] };
  }
  if (entries.length > 500) diagnostics.push(issue(folder, 'schema', 'node-package-count-limit', 'El catálogo supera 500 paquetes; los adicionales quedan sin cargar.', { severity: 'warning' }));
  for (const name of entries.slice(0, 500)) {
    const path = `${folder}/${name}`; paths.push(path);
    try {
      const bytes = await fileBytes(root, path, maxPackageBytes);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const errors = validateDeclarativeNodePackage(value);
      if (errors.length) {
        diagnostics.push(...errors.map((error) => issue(path, 'schema', error.detail, error.message, { severity: 'warning' })));
        continue;
      }
      const pkg = value as DeclarativeNodePackage;
      if (name !== declarativeNodePackageFileName(pkg)) {
        diagnostics.push(issue(path, 'schema', 'node-package-filename-mismatch', 'El nombre del archivo no coincide con package ID y versión; el paquete permanece inerte.', { severity: 'warning' }));
        continue;
      }
      const added = addDeclarativeNodePackage(registry, pkg);
      if (added.diagnostics.length) {
        diagnostics.push(...added.diagnostics.map((error) => issue(path, 'schema', error.detail, error.message, { severity: 'warning' })));
        continue;
      }
      registry = added.registry; packages.push(pkg);
    } catch (error) {
      diagnostics.push(issue(path, 'syntax', 'node-package-unreadable', error instanceof SyntaxError ? 'El JSON del paquete está mal formado; se conservan sus bytes y se usa fallback.' : 'El paquete no se pudo leer de forma segura; se conserva y se usa fallback.', { severity: 'warning' }));
    }
  }
  return { packages, paths, registry, diagnostics };
}
