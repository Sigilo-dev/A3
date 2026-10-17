# E6-A1 · estado de repositorios locales

Base verificada: `codex/e3-e7-product`, E5-F2 `a2958a1`, origin `https://github.com/Sigilo-dev/A3.git`, árbol limpio al comenzar. Se conserva esa base sin integrar otra rama. Implementación: [ADR 0025](../adr/0025-local-git-status.md). Contratos consultados: E0-A dominio/comandos, E1 broker/montajes y E0-C2; no se cambian esquemas portables.

## Motor opcional comprobado

Comprobado en Windows x64 el 2026-10-17:

| Evidencia | Valor |
|---|---|
| Ejecutable nativo de la instalación del sistema | `Git/mingw64/bin/git.exe` (no el launcher `cmd/git.exe`) |
| Versión reportada | `git version 2.53.0.windows.1` |
| Commit de build | `a5512bdee37ed7142c233d21e2d347ffc4860ff3` |
| SHA-256 del ejecutable | `d09a1324132aa9da4b4c2b14242dcac893539a735fab288136b101156434a55a` |
| Licencia comprobada en `Git/LICENSE.txt` | GPL-2.0-only, con avisos/excepciones de archivos individuales según upstream |
| SHA-256 de ese archivo LICENSE instalado | `5b2198d1645f767585e8a88ac0499b04472164c0d2da22e75ecf97ef443ab32e` |

La [versión oficial](https://github.com/git-for-windows/git/releases/tag/v2.53.0.windows.1) y el [COPYING de Git v2.53.0](https://github.com/git/git/blob/v2.53.0/COPYING) respaldan versión/licencia; la huella se obtuvo del ejecutable instalado, no de un checksum publicado del instalador. Es evidencia local de esa instalación. No se empaqueta ni descarga Git, no se auditan todas sus DLL ni se afirma aprobación de redistribución. Otro ejecutable necesita su verificación explícita y nuevas pruebas.

## Contrato implementado

`inspectGitInstallation()` detecta solo la ubicación estándar o una ruta absoluta facilitada por configuración host. Ausencia produce `not-installed`; binario/versión no comprobado produce `unverified-binary`. No impide abrir proyectos offline.

`LocalGitStatusAdapter.bind()` recibe ID estable, UUID de proyecto, clase de repositorio y raíz concedida por el host. `status(repositoryId, signal)` devuelve rama/HEAD (incluido unborn/detached), entradas con estado separado de índice/worktree y diagnóstico. Un ID externo no cambia el repositorio A3. Subcarpeta sin `.git` devuelve `not-repository` aunque su padre tenga Git. Los bindings permanecen en memoria del host y se retiran explícitamente; no hay rutas de usuario recibidas de renderer.

La API tiene solo lectura. No interpreta URLs ni credenciales, no crea `.git`, no ejecuta comandos al abrir el proyecto y no expone procesos generales. No devuelve stderr, cuerpos de configuración ni URLs remotas. Cada solicitud consulta autorización efectiva antes y después de los comandos; no se instala una concesión por leer una política portable. La integración con UI/broker se deja explícita para E6-A2, sin habilitar Git a agentes por este commit.

El framing sigue [porcelain v2 y separación NUL](https://git-scm.com/docs/git-status/2.53.0); la [documentación de Git](https://git-scm.com/docs/git) define los controles de entorno empleados. Los nombres se decodifican como UTF-8 estricto: bytes inválidos o salida incompleta son `invalid-output`, nunca un estado vacío y limpio. Se respetan los ignores propios de Git y se añaden exclusiones fijas para datos locales/credenciales/caché mediante pathspec y filtrado defensivo. Archivos protegidos ya trackeados generan `PROTECTED_TRACKED_FILES` con conteo; no se ocultan como una garantía de publicación segura.

## Verificación

```text
npm run test:git --workspace @a3/desktop
npm run typecheck --workspace @a3/desktop
npm run build --workspace @a3/desktop
git diff --check
```

`fixtures/e6/git/status.json` contiene únicamente nombres/datos sintéticos y metadatos del motor. `apps/desktop/test/git-status.test.mjs` usa directorios temporales y el Git real fijado para crear sus fixtures; los comandos de setup/commit de test nunca apuntan al proyecto del usuario. Resultado: **15/15 pruebas aprobadas, sin skips** en Windows. Typecheck y build desktop pasan; persiste el aviso previo de chunks grandes del renderer.

Casos comprobados: nombres y raíces con Unicode/espacios/metacaracteres literales, tracked/untracked e índice sin cambios byte por byte; exclusiones incluso de archivos ya trackeados y negaciones de ignore; rama vacía/detached; separación de proyecto y repositorio externo; rechazo de ID no concedido y descubrimiento del padre; entorno `GIT_DIR`/`GIT_WORK_TREE` ajeno; binario ausente/falso; configuración externa/filtros y fsmonitor no ejecutado; raíz movida/sustituida, junctions, gitfiles/alternates/repos anidados; revocación, cambio de configuración y retirada de binding en el límite del comando; cancelación y salida malformada.

## Criterios y límites

- **A3-034, parcial:** estado Git local real sin GitHub verificado. Diff, stage/commit/log/branch/restore y la validez de metadatos tras restaurar pertenecen a E6-A2 y bloques siguientes; no se declaran cubiertos aquí.
- **A3-002/003/024, parte aplicable:** raíces faltantes/sustituidas y referencias externas producen estados recuperables; no se convierten en repositorios vacíos ni se modifican sus bytes.
- **A3-031/032, parte aplicable:** autorizar/retirar una raíz es responsabilidad host, el renderer no recibe un escape de comandos. Esta API exige autorización, pero no cambia por sí misma la política efectiva ni la disponibilidad global de Git en el broker actual.

No se probó sandbox de kernel, cambio hostil exactamente durante una syscall, límite real de CPU/memoria, distribución de Git, Git LFS/filtros, worktrees enlazados, submódulos ni operaciones remotas. La configuración y preinspección conservadoras diagnostican los casos no admitidos. No se ofrece una API de escritura y no se promete atomicidad de una lectura de estado frente a editores externos.
