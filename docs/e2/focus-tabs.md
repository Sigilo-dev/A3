# E2-F1 · focus y restauración de pestañas

Trazabilidad: especificación §9.3, **A3-004 y A3-009**. [ADR 0011](../adr/0011-focus-session.md). Continúa E2-E1 sobre `116f873`, en `codex/e2-canvas`.

## Comportamiento

- Doble clic en una página del canvas, o su acción de apertura, abre el editor completo en una pestaña a la derecha de la actual. Abrir la misma entidad otra vez activa su pestaña existente.
- **Abrir otra vista** conserva entity/resource IDs con un ID de pestaña nuevo. Cada vista tiene su propio modo, selección y posición de lectura. Al guardar se actualizan las vistas limpias; un borrador concurrente conserva su revisión y usa la resolución de conflicto existente.
- La tira permite seleccionar, cerrar y cambiar de orden con las acciones izquierda/derecha. Cerrar una pestaña no modifica el archivo. El selector de workspace abre o activa su pestaña, conservando la cámara local.
- Se mantienen visual, fuente y preview, herramientas Markdown, feedback de guardado/error y las restricciones de conservación de E2-D1/D2. Los editores de las pestañas inactivas se destruyen; sus buffers y posiciones permanecen en memoria de esa sesión.
- Cambiar/cerrar proyecto confirma los borradores: **Guardar y continuar**, **Descartar borradores** o **Cancelar**. Cancelar o fallar un guardado mantiene la sesión y los documentos. Las vistas se guardan una a una: no se promete un commit atómico de todos los buffers.

## Restauración y diagnóstico

El host mantiene una sesión versionada por identidad de carpeta y UUID de proyecto, fuera de los datos portables. Guarda únicamente vistas: orden, pestaña seleccionada, modo, scroll, caret/selección y viewport de workspace. No guarda fuentes Markdown, credenciales, permisos ni session IDs. Un clon no hereda la sesión de la carpeta original. Un archivo local de sesión corrupto se diagnostica sin reemplazarlo por uno vacío.

Al salir se recuerda el reciente activo. El siguiente arranque lo reabre solo si conserva permiso local de lectura. Si falta la unidad o se revocó el permiso, se muestran recientes y una indicación para localizar/abrir. Cerrar el proyecto explícitamente suprime la reapertura automática, pero conserva sus pestañas para cuando se abra manualmente.

Si falta un Markdown al restaurar, su pestaña muestra diagnóstico, **Localizar**, **Ver referencia** y **Reintentar lectura**. Se mantienen IDs y ruta original; no se crea texto vacío. Localizar un archivo interno pide elegir y confirmar un `.md` UTF-8 dentro del proyecto. El writer actualiza el descriptor existente mediante journal, sin mover o sobrescribir el texto seleccionado. Fuera de la raíz, con permiso denegado, con otra versión o con un hash modificado no se aplica la reparación. Un montaje usa su aprobación local y sigue en solo lectura; un descriptor inexistente exige recuperación explícita de ese descriptor.

La posición se restaura dentro de los límites del documento y del tamaño de ventana actual. Un cambio posterior de contenido puede ajustar un caret fuera de rango; no se interpreta su offset como ID de bloque. Las garantías de enlaces y navegación semántica se desarrollan en E2-F2.

## Teclado y foco

La tira usa `tablist`, `tab`, `tabpanel`, selección ARIA y nombres accesibles. Flechas/Home/End desplazan el foco; Enter/Espacio activan la vista. Supr o Ctrl+W desde una pestaña solicitan su cierre. Los botones de cierre tienen el nombre de su página y el foco es visible. Los diálogos nuevos mantienen Tab dentro de sus controles, Escape cancela y se devuelve el foco al control de origen cuando existe. El editor conserva Ctrl+S y los atajos de su motor; esto no completa toda la accesibilidad de A3.

## Comprobaciones

- `node --test packages/project-store/test/workspace-session.test.mjs`: apertura repetida, inserción a la derecha, otra vista con mismos IDs, orden/selección/cámara/caret, cierre sin borrar bytes, reinicio del gestor con session ID nuevo, clon aislado, cierre explícito, archivo de sesión corrupto preservado, lectura revocada, recurso faltante y reparación con rechazo de escapes/hashes obsoletos/permisos.
- `npm run test:focus --workspace @a3/desktop`: dos procesos reales de Electron con el mismo perfil temporal. El primero prueba doble clic, vistas, edición seguida de cambio inmediato, guardado compartido, cancelación y fallo de guardado, cierre y teclado. Tras cerrarlo se mueve un Markdown de prueba; el segundo restaura pestañas y viewport, muestra diagnóstico, conserva la referencia y prueba Localizar con igualdad de bytes.
- `npm run test:smoke --workspace @a3/desktop -- --editors-only`: regresión de ciclo local, Markdown y CodeMirror, aislamiento/CSP e IPC de sesión denegado a otra ventana.
- `npm test`, `npm run build --workspace @a3/desktop` y `npm audit --omit=dev`: contratos/dominio/store/viewport/lenguajes, tipos y bundles, y dependencias de producción.

Los fixtures son temporales. El único paquete declarado directamente adicional es `@milkdown/prose` 7.22.3 (MIT), ya presente en el lock; no cambia su versión ni actualiza el resto de dependencias. El nonce de estilos permite el layout dinámico de CodeMirror bajo la CSP de producción. No se certifican Linux, instalador, restauración de borradores ante caída del proceso, offsets semánticos tras cualquier edición externa ni la totalidad de preferencias/accesibilidad.

Resultados observados en Windows: tipos/build y la suite general pasan; las siete pruebas dirigidas finales de sesión pasan. El recorrido de focus pasa en los dos procesos de Electron, y la regresión de editores también pasa con red bloqueada, CSP y rechazo de IPC desde otra ventana. La auditoría de producción informa cero vulnerabilidades. Se añadieron reintentos acotados a la limpieza de fixtures temporales para tolerar handles transitorios de Windows.
