# E1-F1: crear, abrir y relocalizar proyectos locales

La pantalla Proyectos está conectada al host Electron, al broker y al store E1. Se puede crear una carpeta nueva con nombre, incorporar una carpeta existente tras revisar los metadatos, abrir recientes, cerrar/reabrir y localizar un proyecto movido. El renombrado del proyecto conserva su UUID y aumenta su revisión mediante el comando de dominio. No requiere Internet, Git ni GitHub.

## Flujo y datos

- **Crear:** introduce nombre y selecciona la carpeta padre. La preview muestra la carpeta nueva, los archivos y directorios antes de escribir. Un nombre de carpeta reservado, traversal, carácter no válido o destino existente se rechaza.
- **Incorporar:** selecciona una carpeta sin `a3.project.json`. La preview lista las entradas existentes y los metadatos nuevos. Cancelar no crea metadatos ni mueve archivos. Confirmar muestra otro diálogo nativo con el destino. Un `.a3` previo sin intención local de bootstrap reconocida produce conflicto y exige revisión.
- **Metadatos:** manifiesto E0 `1.0.0`, Workspace «Principal» con viewport inicial y `.a3/.gitignore` que excluye `/local/`. Las carpetas iniciales siguen §7.1. No se inventan documentos vacíos de políticas, montajes o paquetes sin contrato. Los `.gitignore`, README, Markdown, código y binarios previos conservan sus bytes.
- **Abrir:** valida UUID/formato con el codec y abre el servicio E1; admite su modo degradado o solo lectura. Un major futuro no se reescribe. Un manifiesto sin identidad válida se conserva y diagnostica.
- **Recientes:** `userData/local-projects/projects.json` conserva hasta 30 entradas locales. Abrir una ruta ausente no la recrea. Localizar valida el UUID del proyecto elegido antes de cambiar la entrada. Las nuevas rutas requieren sus propias concesiones locales; las referencias portables permanecen intactas y no heredan bindings de mounts.
- **Sesiones:** la interfaz solo envía acciones tipadas e IDs, con validación de emisor/frame y de campos en main. Cada apertura produce un session ID nuevo. El borrador de nombre se conserva durante la navegación y se aplica al guardar, cerrar o cambiar; un nombre inválido o un fallo de guardado mantiene abierto el proyecto. Se puede descartar el borrador explícitamente. Cerrar la ventana drena las operaciones antes de salir.

`LocalProjectManager` concentra el ciclo del host. El bootstrap usa staging y journal D1 con propietario único por carpeta; registra la intención local antes de tocar metadatos y publica el manifiesto al final. Tras una interrupción, abrir la carpeta aplica D1 incluso sin manifiesto. Si el lote parcial revierte, se ofrece nueva confirmación para reintentar. No hay atomicidad del conjunto ni promesa de durabilidad ante corte físico. Puede quedar una carpeta nueva vacía o directorios/artefactos de recuperación tras cancelar una aprobación tardía o fallar una creación; el contenido previo no se elimina para ocultar ese estado.

El catálogo local tiene su propio propietario Windows. Su JSON inválido no se sustituye por uno vacío. Un error al actualizar recientes después de guardar un nombre se informa como `RECENTS_SAVE_FAILED`: el nombre canónico ya está guardado y reabrir sincroniza el catálogo. El catálogo no se comparte con el proyecto y no contiene credenciales, cookies, OAuth ni permisos efectivos.

La exclusión `.a3/.gitignore` se instala antes del journal como prerrequisito no destructivo y se conserva al revertir. Si su contenido cambió, el bootstrap se detiene en vez de reescribirlo.

## Estados recuperables

| Estado | Respuesta |
|---|---|
| Nombre o carpeta inválidos / duplicados | Corregir nombre o abrir la carpeta existente; no sobrescribe destinos. |
| Unidad o carpeta ausente (`ENOENT`) | Conserva reciente/referencias y ofrece Localizar. |
| Falta de permiso (`PERMISSION_DENIED`, `EACCES`, `EPERM`) | Error visible y revisión de permiso local; no muestra archivo vacío. |
| `.a3` previo, destino aparecido o raíz sustituida | Conflicto; conserva lo encontrado. |
| Formato futuro | Abre en solo lectura con diagnóstico. |
| Journal pendiente o corrupto | Recupera bajo D1 o bloquea con diagnóstico; conserva evidencias. |
| Catálogo ocupado o corrupto | No lo reescribe; usa la ventana propietaria o revisa el archivo local. Se permite salir sin forzar la carga de un catálogo roto. |
| Sesión/preview obsoletas | Rechaza la acción y exige volver a abrir o previsualizar. |

## Reproducción y evidencia

Desde la raíz: `npm ci`, `npm run dev`. `predev` construye dominio y store antes del runtime. `npm run build` compila main/preload/renderer y sus paquetes locales; `pretypecheck` también prepara sus declaraciones para una instalación limpia. El único cambio al lock es el vínculo del workspace desktop a `@a3/project-store`; no cambia ninguna versión externa. El store y dominio quedan incluidos en el bundle de main; el renderer no recibe Node.

Pruebas de Windows con fixtures temporales:

- `npm test`: 184 aprobadas (34 contratos E0 + 44 dominio + 106 store); incluye creación/renombrado/cierre/reapertura, cancelación de incorporación, igualdad byte a byte de archivos anteriores, carpeta movida y relocalizada con UUID, formato desconocido sin escritura, nombres duplicados/destinos cambiados, aprobación denegada, sesión obsoleta y guardado antes de cambiar.
- Bootstrap interrumpido mediante hook después de staging y después de instalar el workspace o el manifiesto: D1 revierte o confirma; repetir la apertura no duplica Workspace ni modifica bytes confirmados.
- Propietario único del catálogo y conservación de JSON local truncado; cierre posible después de diagnosticarlo.
- `npm run test:desktop`: UI real con Electron 44.7.2, diálogo de carpeta/confirmación sustituido por el harness, HTTP/HTTPS externos bloqueados, creación/reapertura, guardado del borrador al cerrar, relocalización, cancelación/incorporación con bytes intactos, validación IPC y rechazo de una ventana ajena. También conserva los smoke de arranque negativo y aislamiento de renderer. La captura de verificación está en `apps/desktop/dist/smoke.png` (salida local ignorada).

No se ensayó desconexión física de disco ni ACL de un volumen real de usuario. No se creó instalador, se hizo auditoría de publicación o se validó Linux. Los fallos del bootstrap usan hooks de excepción; las terminaciones reales de procesos D1 siguen cubiertas por su suite anterior. Estos casos respaldan A3-001–003 en el flujo local Windows implementado; no completan el resto del explorador, indexación o UI de mounts de F2.

## Git opcional

Crear o incorporar no llama a Git. El broker mantiene Git deshabilitado hasta contar con un adaptador seguro probado; este corte no ofrece un botón operativo de inicialización. La futura acción opcional deberá mostrar la carpeta y rama `main` y pedirse explícitamente. No se conecta ni publica en GitHub. Esta limitación se conserva de E0/E1-E1 y queda fuera de la aceptación del flujo local sin Git.

La [ADR 0008](../adr/0008-local-project-lifecycle.md) registra la estructura y decisiones nuevas.
