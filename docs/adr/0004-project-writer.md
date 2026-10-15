# ADR 0004 — Escritor de proyecto E1-C2 en Windows

Estado: implementado para host Node/Windows y volumen local compatible. Fecha: 2026-10-15, America/Lima. Base E1-C1 `276cdb8`, contratos E0-A, evidencia E0-C1 y especificación local §§7–8/18/28. No modifica esquemas E0/E1 ni incorpora bibliotecas nuevas.

## Propiedad y permisos

Un named pipe `a3-writer-<sha256(dev:ino)>` arbitra la propiedad del directorio real. Se usa `node:net`, sin TCP ni protocolo de comandos: conexiones entrantes se cierran. La implementación libuv incluida en Node 24.13.1 intenta crear la primera instancia de pipe y devuelve EADDRINUSE si ya existe. Se probó con dos procesos Windows reales, no con un PID guardado en un lockfile. Cerrar el último lease libera el pipe; terminar el proceso también lo libera. La identidad del directorio se comprueba nuevamente al escanear para evitar seguir escribiendo sobre una carpeta sustituida con otro propietario lógico.

Ventanas del mismo host reutilizan la misma instancia y cola mediante leases, incluso si abren simultáneamente. La referencia de `StoreHost` debe ser la misma para reutilizar su contexto de permisos. Otro host/proceso recibe un servicio en solo lectura con reason `writer-busy`; no se transfiere ni roba el dueño. Si el mecanismo Windows no está disponible, no se habilita un writer alternativo inseguro. Linux permanece en solo lectura hasta implementar/probar su arbitraje.

El host proporciona identidad autenticada, AuthorizationPort del dominio y `authorizeAccess` para abrir proyecto, leer Resource y escribir rutas/refs concretas. No hay política allow por defecto. Las concesiones no proceden del JSON, operationId ni de la autorización OAuth. Preparación y commit vuelven a consultar la política; el dominio revalida actor, reglas, revisiones y propuesta. La escritura de bytes tiene una concesión explícita de Resource/ruta. Cambiar el actor invalida una propuesta previa. Los planes son tokens privados del servicio, con bytes propios y copias para preview; no se acepta un objeto forjado.

## Protocolo de escritura y persistencia

Las lecturas y operaciones del servicio pasan por una cola. Preparar no reserva revisiones: dos propuestas sobre la misma base pueden prepararse, pero el segundo commit falla si el primero cambió esa base. Se comparan hashes de bytes e identidades de archivos del catálogo y de fuentes observadas, además de revisiones del dominio; un cambio externo sin incremento de revisión también produce REVISION_CONFLICT.

El registro operativo siempre reside en `.a3/local/transactions/<operationId>/`, incluso si `catalogRoot` es distinto. Así permanece excluido de Git por las reglas existentes y se puede descubrir si el manifiesto queda temporalmente separado de su nombre. Una carpeta de operación existente nunca se reutiliza. El registro no contiene fuentes en base64 ni el payload de prompts: conserva SHA-256 de la solicitud, readSet por ruta/hash/identidad y entradas con hashes anterior/posterior, refs y nombres relativos de artefactos. Las fuentes/JSON se guardan en archivos separados.

Orden del protocolo `a3.store.detached-link/1`:

1. Crear carpeta exclusiva y escribir/sincronizar `intent.json` y el primer evento. Solo después crear directorios de destinos nuevos.
2. Guardar/sincronizar una copia `.before` de cada archivo previo y dos copias independientes de los bytes nuevos: `.staged` para preservar la propuesta y `.candidate` para instalarla. Comprobar soporte de hardlink antes de modificar destinos y comprobar mismo volumen. Revalidar dependencias tras staging.
3. Antes de cada efecto, sincronizar su evento de intención. Para un destino previo, renombrarlo a `.detached` dentro de la operación y verificar los bytes capturados. No eliminar ese objeto: conserva incluso escrituras posteriores de un handle externo que estuviera abierto.
4. Crear un hardlink de `.candidate` al nombre de destino libre. La creación exclusiva falla si un editor externo ganó ese nombre; nunca se usa un rename que reemplace ese archivo ajeno. Una baja solo separa el nombre antiguo conservando el objeto en `.detached`.
5. Verificar hashes de destinos, copias previas, objetos capturados y staging; revalidar permisos y catálogo. Sincronizar `verified` y luego `committed`. Solo entonces devolver recibo y evento de confirmación, ambos con `atomic: false`.

Existe un intervalo sin el nombre antiguo entre separación e instalación. Los demás lectores pueden observar estado intermedio. NTFS/hardlinks son un requisito de este mecanismo Windows; si no se pueden crear, se falla antes de separar destinos. Las APIs y sus fallos reales también condicionan permisos, antivirus y archivos abiertos. No se afirma atomicidad global ni sustitución continua de un archivo. Los nuevos archivos heredan metadatos/permisos de su temporal; no se anuncia preservación de ACL, ADS o topología de enlaces del archivo anterior.

Si los bytes capturados ya no coinciden, se intenta únicamente volver a enlazar ese objeto al nombre original si sigue libre. Nunca se reemplaza un nombre ajeno ni se borra la captura. Es una compensación puntual antes de instalar ese destino, no recuperación de la operación completa. Cualquier fallo tras crear la intención deja el servicio en `recovery-required`; se conservan todos los artefactos y se rechazan más escrituras. Una operación parcial no se comunica como confirmada.

## Contrato de avance para E1-D1

`service-types.ts` publica WriteIntent/IntentEntry/ProgressEvent. El journal es NDJSON UTF-8, cada evento con schemaVersion 1.0.0, secuencia, previousHash y hash SHA-256 del cuerpo JSON canónico con LF. La secuencia correcta es `intent`, un `staged(index)` por entrada, parejas `detach-start/detached` cuando había destino, parejas `install-start/installed` cuando hay salida, `verified`, `committed`. Fallos añaden `failed` cuando es posible; compensación puntual añade `restored-link`. Cada append se sincroniza antes de continuar.

Al abrir, C2 solo reconoce como cerrada una cadena completa y en el orden esperado, enlazada al hash del intent. Versión/protocolo desconocido, bytes ambiguos/UTF-8 inválido, ausencia, truncamiento, hash roto o avance no confirmado quedan pendientes. Tener el pipe libre no acredita que el proyecto esté recuperado. Se abre en solo lectura sin corregir ni eliminar nada. E1-D1 debe validar y recuperar esos artefactos, decidir completar/revertir por hashes, preservar cambios externos y soportar recuperación interrumpida. No debe usar PID, tamaño o mtime como sustitutos de esa validación.

Repetir el mismo token devuelve el recibo/error en memoria sin efectos repetidos. Reusar un operationId cuyo directorio ya existe se rechaza. El ledger durable de resultados y reintentos entre reinicios queda pendiente en E1-D1; no se afirma exactamente una vez.

## Observación externa

Un watcher recursivo usa eventos de directorio como indicios y compara bytes/identidad tras debounce (50 ms por defecto). Un sondeo de 2 s complementa eventos perdidos; fuentes con stat estable reutilizan hash durante el sondeo. Las comprobaciones críticas y las notificaciones nativas fuerzan lectura de bytes. Se distinguen edición, borrado, creación y reemplazo, incluso reemplazo con contenido idéntico. JSON inválido conserva bytes y diagnósticos C1.

Las observaciones del watcher no sustituyen la base aceptada por el editor. Un conflicto permanece hasta `reload()` explícito, que acepta una nueva base válida sin mezclar datos. La propuesta mantiene sus bytes para preview/resolución. Desaparecer un descriptor no se confunde con borrar su archivo físico. Los writes propios se identifican por hashes/identidades esperadas, no por una ventana de silencio que ocultaría una edición externa. Avisos repetidos de la misma observación no producen conflictos duplicados.

Se observan catálogo y Resource project-file conocidos, sin indexar todo archivo no referenciado ni seguir montajes/URLs. `.git` y `.a3/local` no disparan escaneos por evento. Un error del watcher informa diagnóstico; el sondeo y las precondiciones siguen activos. El root trasladado/reemplazado exige cerrar y abrir; no se redefine su dueño automáticamente.

Límites: los checks lstat/realpath/identidad no confinan un proceso malicioso ni cierran toda carrera de rutas; E1-E debe abordar esa frontera. No se sincroniza metadata de directorio con una garantía Win32 demostrada, no se midió power loss, y fsync exitoso no lo prueba. Escrituras tardías mediante handles viejos pueden seguir afectando a `.detached`; se comprueban antes de confirmar y se conservan esos objetos, pero C2 no es un monitor permanente de todo el historial local. No hay cleanup de backups ni recuperación automática en este corte.

Fuentes primarias consultadas: [libuv en Node 24.13.1, first pipe instance](https://github.com/nodejs/node/blob/v24.13.1/deps/uv/src/win/pipe.c), [Node v24 fs.watch y sus límites](https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener), [Microsoft CreateHardLinkW: volumen y semántica de enlaces](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw). La evidencia E0-C1 sigue delimitando fsync/rename, directorios y cortes de energía.
