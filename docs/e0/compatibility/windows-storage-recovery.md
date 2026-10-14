# E0-C1 — escritura y recuperación en Windows

Consulta de documentación: 2026-10-14. Especificación maestra A3 1.0.0, §§7, 8, 21, 28 y 30; contratos E0-A, especialmente `commands-and-migrations.md` y `domain.md`. Esta prueba estudia un protocolo pequeño, desechable y solo para datos sintéticos. No implementa `project-store` ni acredita una transacción de producto.

## Entorno y reproducción

Comando desde la raíz del repositorio:

```powershell
npm test --prefix experiments/e0/windows-storage
```

Resultado observado: exit code 0, 13 casos, 0 fallidos. Windows 10 Pro, versión 10.0.19045 (22H2), volumen temporal C: NTFS; Node.js v24.13.1, npm 11.10.0. La documentación oficial de la rama Node 24 consultada ese día identifica v24.22.0; el binario probado es v24.13.1. No se ejecutó Electron: su proceso principal usa Node.js y las API `node:fs`, pero esta prueba no certifica una versión empaquetada concreta de Electron.

El runner crea un directorio único `a3-e0-c1-*` dentro de `%TEMP%`, verifica que su raíz resuelta siga bajo el directorio temporal y que tenga el prefijo propio, y borra recursivamente solo esa raíz en `finally`. Cada proceso de fallo recibe únicamente una subcarpeta allí. El proceso reiniciado lee su journal y los archivos sintéticos del caso. No se abrió ni modificó ningún archivo del proyecto, repositorio o perfil del usuario. Las tres ejecuciones terminadas limpiaron sus directorios temporales; el harness también los elimina después de cada ejecución.

No se usan paquetes npm externos. El caso normal comprueba que destino, staging y raíz del caso reportan el mismo volumen (`stat.dev`). Los nombres y el JSON incluyen `東京`, `ñ`, `café` y `🧪`, tienen UTF-8, dos espacios y LF final. Dos documentos JSON ya existentes avanzan de revisión 1 a 2. SHA-256 se calcula sobre los bytes exactos; las precondiciones comprueban los hashes base y el journal incluye revisiones, hashes anteriores y posteriores, backups y eventos.

## Casos ejecutados

El comando de la primera columna es el comando público reproducible. El runner crea los datos y lanza los comandos de worker indicados con `<temporary-case-root>` como marcador de la carpeta temporal efímera. Las salidas de recuperación se comparan además con los hashes completos esperados; los fragmentos no son la comprobación.

| Caso / invocación dentro del runner | Esperado | Observado en esta ejecución | Limitación |
|---|---|---|---|
| `npm test --prefix experiments/e0/windows-storage` — reemplazo normal | Leer UTF-8; sustituir un destino existente; ambas revisiones/hashes posteriores coherentes. | Pasó. Destino con revisión 2, UTF-8/LF correcto, staging, backup, journal y destino en el mismo volumen. | Solo Node v24.13.1 sobre este volumen NTFS y documentos sintéticos; no es el project-store. |
| `node worker.cjs apply <temporary-case-root> before-replace-1`; luego `node worker.cjs recover <temporary-case-root>` | Ninguna sustitución; ambas copias previas. | `apply` salió 86 por terminación inyectada; recovery salió 0, rollback sin archivos modificados. | `process.exit(86)`; el kernel sigue vivo, no simula corte de energía ni muerte durante journal/recovery. |
| `node worker.cjs apply <temporary-case-root> after-replace-1`; luego `recover` | Revertir reemplazo 1 y dejar ambos hashes previos. | Exit 86; recovery restauró el documento 1 desde backup y verificó ambos hashes previos. | Mismas limitaciones de terminación de proceso; una sustitución de archivo no prueba atomicidad entre documentos. |
| `node worker.cjs apply <temporary-case-root> before-replace-2`; luego `recover` | Revertir reemplazo 1; documento 2 sigue previo. | Exit 86; recovery restauró el documento 1 y verificó ambos hashes previos. | Mismas limitaciones de terminación de proceso; no se probó interrupción al escribir eventos del journal. |
| `node worker.cjs apply <temporary-case-root> after-replace-2`; luego `recover` | Revertir los dos reemplazos y dejar ambos hashes previos. | Exit 86; recovery restauró los dos backups y verificó ambos hashes previos. | Mismas limitaciones de terminación de proceso; sin fallo de hardware ni prueba del recovery interrumpido. |
| `node worker.cjs apply <temporary-case-root> before-commit`; luego `recover` | Sin marcador de commit: revertir ambos documentos. | Exit 86 después de reemplazar ambos; recovery restauró ambos hashes previos. | No se inyectó fallo en medio de la escritura del marcador/journal. |
| `node worker.cjs apply <temporary-case-root> after-commit`; luego `recover` | Con marcador de commit: conservar ambos hashes posteriores. | Exit 86 después de confirmar; recovery verificó los dos hashes posteriores y conservó la transacción. | El marcador se sincronizó antes de salir; no se cortó la energía para probar si sobrevive. |
| `npm test --prefix experiments/e0/windows-storage` — edición externa antes de `apply` | Detectar precondición obsoleta antes de escribir; no sobrescribirla. | Salida 42 `REVISION_CONFLICT`; primer documento intacto y bytes externos del segundo intactos. | Dos documentos sintéticos y cambio coordinado por el test; no hay watcher ni dos editores reales. |
| `apply ... after-replace-1`; edición externa del segundo JSON; luego `recover` | Conflicto explícito; deshacer solo el cambio propio y preservar los nuevos bytes externos. | Recovery salió 2 con `RECOVERY_CONFLICT`; restauró el documento 1, preservó exactamente el hash externo del documento 2. | El conflicto se comunica por estado de salida; no hay diff, merge ni resolución en UI. |
| `npm test --prefix experiments/e0/windows-storage` — sondeo con `fsyncSync`/`fdatasyncSync` y sync de carpeta | Registrar capacidad efectiva del runtime. | Ambas llamadas de sync al archivo devolvieron éxito; `fsyncSync` sobre carpeta falló `EPERM`. | Solo la combinación de este runtime y volumen; no demuestra persistencia física ni flush de entradas de directorio. |
| `npm test --prefix experiments/e0/windows-storage` — segundo `openSync(path, 'wx')` sobre lockfile existente | El segundo creador exclusivo recibe `EEXIST`. | `EEXIST`, como esperado. | Creación exclusiva de lockfile; no prueba bloqueo de rango del kernel, liveness ni reclamación segura. |
| `npm test --prefix experiments/e0/windows-storage` — crear/leer ruta Unicode de 336 caracteres | Registrar si este host/runtime permite superar 260 caracteres. | Creación y lectura correctas. No se inspeccionaron por separado el manifiesto de `node.exe` ni la política de registro de rutas largas. | Resultado específico de este Node, host, volumen y temp path; no certifica futuros binarios Electron ni otros sistemas. |
| `npm test --prefix experiments/e0/windows-storage` — JSON truncado junto a otro documento válido | No cambiar los bytes dañados ni el otro documento al diagnosticar el parseo. | El JSON inválido produjo error de parseo; bytes originales y el segundo archivo quedaron idénticos. | No implementa lector de proyecto, apertura degradada, diagnóstico global ni restauración. |

En cada interrupción, el código de salida 86 es un `process.exit(86)` del proceso worker, y un proceso nuevo ejecuta la recuperación. La matriz demuestra que este protocolo de ensayo no acepta en silencio un estado mixto: antes del marcador restaura lo que aún coincide con el hash posterior de la operación; con marcador valida todo el conjunto; ante bytes desconocidos conserva el archivo externo y devuelve conflicto. El diseño de este harness es demostrativo, no una recomendación de implementar literalmente sin revisión.

## Decisión técnica provisional para E1

Mantener un escritor único por carpeta de proyecto y enviar todos los cambios por el servicio de proyecto de E0-A. Antes de aplicar, comprobar revisiones esperadas y hashes SHA-256 de los bytes que condicionan la operación. Preparar nuevos archivos y copias recuperables en el mismo volumen; sincronizar cada archivo temporal y evento de journal que preceda a una modificación; sustituir destinos uno a uno; verificar el conjunto por hash; y publicar el marcador de commit antes de notificar éxito.

Al recuperar, un marcador confirmado exige que todos los destinos coincidan con sus hashes posteriores. Sin marcador, revertir únicamente los destinos que aún coincidan con los hashes posteriores propios. Si un archivo contiene otros bytes, no reemplazarlo: conservarlo, completar las restauraciones seguras y devolver `REVISION_CONFLICT` con las rutas implicadas. La UI no debe mostrar “Guardado” hasta que el servicio confirme, según §8.1. Hash sirve para detectar cambios, no concede permiso ni reemplaza la revisión.

`open(..., 'wx')` es útil para detectar colisión al crear un lockfile. Este resultado no demuestra bloqueo de rango del kernel, propiedad viva, liberación automática tras caída ni transferencia segura. Para E1, conservar el requisito de E0-A de escritor único y abrir otras instancias en lectura; decidir mediante ADR si el arbitraje entre procesos usa mutex nombrado del sistema, bloqueo nativo u otro mecanismo, incluyendo recuperación de lock obsoleto. No tratar un PID escrito en un archivo como prueba suficiente de que el dueño dejó de existir.

## Garantías y límites del sistema

La API estable de Node 24 documenta `fsync`/`FileHandle.sync` para solicitar que se vacíen datos del archivo y `fdatasync` para vaciar datos sin metadata modificada. Node indica que la implementación concreta depende del sistema y del dispositivo. En este host ambas llamadas al archivo funcionaron; sincronizar el directorio devolvió `EPERM`. `rename` se documenta como renombrar una ruta, sin parámetro de durabilidad. Por ello este arnés no pudo demostrar la persistencia de entradas de directorio tras pérdida de energía.

Windows documenta `FlushFileBuffers` para vaciar buffers de un handle de archivo. También documenta `ReplaceFileW` y `MoveFileExW`; este último ofrece el flag `MOVEFILE_WRITE_THROUGH` para esperar a que termine y se vacíe a disco un movimiento que se realice como copia y borrado. El spike no llama directamente a estas funciones ni configura dicho flag: ejercita únicamente `node:fs.renameSync` y `fsyncSync`. La existencia de una API nativa no prueba que el runtime la use con los flags o secuencia necesarios. Incluso una sustitución individual de archivo no vuelve atómica la secuencia de varios destinos.

En Windows 10 1607 o posterior, quitar el límite `MAX_PATH` requiere tanto política `LongPathsEnabled` como declaración `longPathAware` del ejecutable. La ruta de 336 caracteres funcionó con este Node y este host, pero no se aisló cuál configuración permitió el resultado. No certifica rutas largas para futuros binarios de Electron, otras políticas corporativas, volúmenes, carpetas sincronizadas, red o todos los APIs usados por la aplicación.

Una llamada de flush que devuelve éxito no es un ensayo de pérdida de energía. Controlador, firmware, caché de escritura, sistema de archivos, dispositivo y su configuración quedan fuera del alcance de un proceso terminado normalmente por el sistema operativo. No se cortó la alimentación ni se reinició el host. Por tanto no se declara ni verifica durabilidad ante corte real de energía. Tampoco se inyectó muerte durante una escritura del journal, antes de su primer evento preparado o durante el propio recovery; no se probó la reanudación de una restauración parcialmente interrumpida.

## Trazabilidad y asuntos abiertos

| Requisito | Evidencia de este spike | Estado de aceptación |
|---|---|---|
| A3-001 crear/reabrir proyecto; A3-002 incorporar carpeta existente | JSON sintético, sustitución y lectura local. No hay app, creación de proyecto ni importación de una carpeta previa. | No demostrado. |
| A3-003 portabilidad | Archivos internos temporales en un volumen NTFS. | No probado copiando a otra ruta/equipo ni resolviendo montajes. |
| A3-045 corrupción localizada | JSON inválido preservado junto a un documento intacto. | Parcial: no hay lector A3, modo degradado, diagnóstico de proyecto ni restauración. |
| A3-046 interrupción de guardado | Seis salidas forzadas antes/después de reemplazos 1 y 2, antes del marcador y después de commit. Recovery validó hashes de todo el conjunto. | Parcial: solo caída de proceso; quedan journal truncado, recovery interrumpido, Electron y pérdida real de energía. |
| A3-047 edición externa concurrente | Hash previo obsoleto y edición posterior a un reemplazo fueron detectados; bytes externos conservados. | Parcial: sin watcher, dos editores reales, diff ni resolución de UI. |
| A3-048 migración | No se ejecutó ni simuló migrador. | No probado. |

Decisiones para ADR antes de producción: mecanismo de lock interproceso y transferencias; formato/detección de journal truncado; cómo sincronizar metadata de directorio y qué garantía ofrecer por filesystem; recuperación que también pueda interrumpirse; y cómo mostrar/combinar un conflicto externo sin perder ninguna versión. El objetivo de <1 s de guardado de §8.1 no se midió. La secuencia de reemplazos nunca se presenta como transacción atómica global.

Documentación oficial consultada el 2026-10-14:

- [Node.js v24 — File system](https://nodejs.org/docs/latest-v24.x/api/fs.html) — `sync`, `datasync`, `rename`, banderas `wx`; documentación de la rama v24, no la versión local exacta.
- [Electron — Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) — el proceso principal ejecuta Node.js y tiene acceso a sus APIs.
- [Microsoft — FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) — vaciado de buffers para un handle.
- [Microsoft — ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) y [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) — APIs de reemplazo/movimiento; el segundo documenta `MOVEFILE_WRITE_THROUGH`.
- [Microsoft — Maximum Path Length Limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) — condiciones de política y manifiesto para rutas largas.
