# E1-C2 — Servicio escritor y cambios externos

Base: E1-C1 `276cdb8`, origin `https://github.com/Sigilo-dev/A3.git`, rama `codex/e1-base`, limpia al iniciar. Fecha de cierre: 2026-10-15, America/Lima. La [ADR 0004](../adr/0004-project-writer.md) y los tipos de `packages/project-store/src/service-types.ts` fijan el contrato de intención/avance que debe consumir E1-D1.

## API del host

Se exporta desde `@a3/project-store`, sin conectarlo aún a UI o IPC. No hay nuevas dependencias ni cambios al lock. Node, TypeScript y Ajv conservan los pins anteriores.

| API | Comportamiento |
|---|---|
| `openProjectService(root, {host, ...options})` | Devuelve lease writer o read-only. Otro proceso activo produce `writer-busy`; al abrir, un journal pendiente se recupera antes de habilitar escritura. Un conflicto o journal aislado produce `recovery-required`. Mismo StoreHost/proyecto comparte servicio y cola. |
| `lease.close()` | Libera esa ventana; el último cierre espera la cola, detiene watcher y libera propiedad. No invocar dispose desde una ventana individual. |
| `service.state` | Proyecto observado, modo/razón, conflicto externo y `recoveryDiagnostics`. `ProjectReadResult.writable` de C1 sigue false; no es el modo del servicio. |
| `service.openResource(id)` | Bytes originales, path, SHA-256, revisión de descriptor y hash de descriptor. Resuelve UUID; no adivina rutas ni abre mounts/URLs. |
| `service.prepare(command)` | Ejecuta núcleo E1-B y codecs C1, produce token/preview de entradas con hashes; no modifica destinos. Copiar/mover fuentes locales conserva bytes. |
| `service.prepareResourceWrite(request)` | Requiere operationId, Resource ID, expectedRevision, expectedHash y Uint8Array. Un cambio de contenido coordina fuente + siguiente revisión del descriptor Resource, conservando sus otros campos. No cambia Entity ni normaliza bytes. |
| `service.commit(token)` | Revalida actor/políticas/revisiones/hashes, staging, avances y verificación. Recibo committed con `atomic: false` solo tras marcador sincronizado. Un fallo puede dejar recuperación pendiente y estado parcial explícito. |
| `service.subscribe(listener)` | Eventos external-change, committed, write-failed y watcher-error. El listener no puede abortar IO ni recibe fuentes en logs. Devuelve unsubscribe. |
| `service.checkExternalChanges()` | Escaneo forzado de comprobación; útil al activar ventana y en pruebas. No acepta automáticamente la base externa. |
| `service.reload()` | Acepta una nueva base íntegra tras revisar un cambio externo normal. No mezcla ni desbloquea una transacción pendiente o en conflicto de recuperación. |

Ejemplo host, después de instalar/compilar desde la raíz:

```ts
const opened = await openProjectService(root, {
  host: {
    authenticatedActor,
    domain: domainAuthorization,
    authorizeAccess: (request) => projectPolicy.allows(request)
  }
});
if (!opened.ok) return showDiagnostics(opened.diagnostics);
const lease = opened.value;
const resource = await lease.service.openResource(resourceId);
if (!resource.ok) return showDiagnostics(resource.diagnostics);
const proposal = await lease.service.prepareResourceWrite({
  operationId, resourceId,
  expectedRevision: resource.value.revision,
  expectedHash: resource.value.sha256,
  bytes: editorBytes
});
if (!proposal.ok) return showDiagnostics(proposal.diagnostics);
const result = await lease.service.commit(proposal.value);
// Solo result.ok autoriza comunicar confirmación. Un error puede requerir reabrir el proyecto para recuperarse.
// Al cerrar la última vista del proyecto: await lease.close().
```

La política del ejemplo pertenece al host: debe implementarse, no se carga del proyecto como código. Para ventanas compartidas se conserva la misma referencia StoreHost. La recuperación vuelve a exigir autorización de escritura de las rutas y, cuando el journal lo contiene, la identidad principal que preparó la operación. El recibo no indica durabilidad física ante corte de energía. Un token/preview no es una concesión para escribir por otro canal.

La máquina de estados de preparación, backups, aplicación, confirmación, rollback y conflicto está detallada con los límites de durabilidad en [E1-D1](transaction-recovery.md).

## Evidencia observada

Windows 10 x64 build 19045, Node.js 24.13.1/npm 11.10.0, volumen temporal local NTFS. Fixtures copiados a carpetas temporales con limpieza restringida al prefijo del test. Ninguna prueba escribe los fixtures originales o datos de usuario.

- Evidencia de E1-C2 al cerrar su commit: `npm test`, 34 E0 + 44 dominio + 68 store = **146 pruebas**, sin fallos. La suite actual añade escenarios E1-D1 de recuperación descritos abajo.
- Suite actual tras E1-D1: `npm test`, 34 E0 + 44 dominio + 74 store = **152 pruebas**, sin fallos; `npm run typecheck` y `npm run build` también pasan.
- `npm run typecheck` y `npm run build`: exit 0. El renderer, preload e IPC conservan su base E1-A; no se empaqueta un instalador nuevo.
- A3-047: un editor externo modifica la fuente después de preparar; commit devuelve REVISION_CONFLICT, bytes externos permanecen y preview conserva la propuesta. Recrear el nombre entre separar/instalar tampoco lo sobrescribe; los bytes anteriores y propuestos quedan en archivos distintos del registro.
- Watcher nativo: JSON inválido, borrado y reemplazo con hash idéntico generan diagnóstico localizado/estado externo; dos escaneos posteriores no duplican el aviso. Abrir/escribir por ID conserva UTF-16/BOM/CRLF y bytes arbitrarios sin normalización.
- Dos procesos: el segundo recibe read-only/writer-busy. Terminar abruptamente al dueño libera el pipe; abrir no elimina un bloqueo por deducir liveness de un PID.
- E1-D1 añade terminaciones de proceso en siete puntos de escritura (incluidos antes y después de instalar y antes/después de confirmar): un lote completo se confirma al reabrir; uno parcial revierte desde backup. Repetir el arranque no vuelve a instalar ni a restaurar los mismos archivos.
- También se termina el proceso durante rollback/confirmación, se interrumpe el aislamiento y se repite la apertura. Las rutas recuperadas mantienen el hash/revisión esperado. Una edición o eliminación posterior se conserva junto con `.before` y `.staged`, y deja el writer en solo lectura con diagnóstico de conflicto.
- Journal JSON/UTF-8 inválido, hash-chain roto, protocolo desconocido o registro truncado se mueve íntegro a `transactions/quarantine/`, se diagnostica y mantiene el proyecto en solo lectura. No se interpreta como operación resuelta.
- `git diff --check`: sin errores. No se cambian esquemas/contratos/fixtures E0, locks de experimentos, versiones externas ni documentos locales ignorados de planificación.

## Garantías y límites

Los fallos comprobados no se comunican como guardado y no se reemplaza una ruta ganada por un editor ajeno. Las sustituciones secuenciales tienen un intervalo sin nombre antiguo y pueden dejar cambios parciales. Esos estados se registran y bloquean la escritura; no se los presenta como transacción atómica ni como recuperación terminada. Las copias `.before`/`.staged` son independientes de los objetos `.detached`/`.candidate` que pueden seguir teniendo handles/enlaces externos.

**A3-046:** hay recuperación determinista ante terminación de proceso y reanudación idempotente. No se ensayó corte de energía ni durabilidad física de directorios. **A3-047 queda comprobado en el servicio:** detección y conservación de versiones; falta la UI para diff/merge y resolución. La revisión tras staging/antes de efectos no equivale a snapshot OS frente a todos los editores.

La persistencia de NodeType/paquetes y la eliminación del directorio completo de un Workspace se rechazan antes de modificar destinos; no se finge haberlos aplicado. La creación de documentos/workspaces, cambios de dominio, eliminación de documentos individuales y copy/move de Resource local sí usan el servicio. Montajes/URLs, migraciones, limpieza irreversible y transferencias de dueño requieren módulos/contratos posteriores. No hay editor Markdown/CodeMirror conectado todavía.

No se implementa Linux writer, arbitraje sobre volúmenes/red no probados, fallback de hardlink a overwrite, garantía de ACL/streams NTFS, barrera OS contra procesos maliciosos, snapshots con retención, interfaz para resolver conflictos ni migraciones. A3-030 queda cubierto para recuperación repetida de la misma operación local, no para reanudar Codex/app-server o guardar un ledger de recibos para reintentos de una petición externa. A3-038 tiene copias recuperables y rollback; historial local visible, Git y restauración elegida por usuario siguen pendientes. A3-048 conserva lectura segura de versiones mayores, pero no ejecuta migraciones. Opciones host: debounce 50 ms, sondeo 2 s, recursos y propuesta 128 MiB por defecto (ajustables). Un cierre espera las operaciones en cola; el mismo token devuelve su resultado sin repetir efectos. Un operationId persistido no se reutiliza.
