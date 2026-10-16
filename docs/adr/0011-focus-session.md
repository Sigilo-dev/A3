# ADR 0011: vistas focus y sesión local por proyecto

Estado: aceptada para E2-F1. Fuentes: especificación §9.3, A3-004/A3-009, identidades Entity/Resource de E0-A y sesión/escritor/broker E1. Base: `116f873` en `codex/e2-canvas`. Es un detalle compatible: no cambia el formato portable ni añade otra copia del documento.

## Identidades y autoridad

Cada pestaña tiene un ID de vista local. Las páginas guardan `entityId` y `resourceId`; «Abrir otra vista» crea un ID de vista nuevo y conserva esos dos IDs canónicos. Los workspaces conservan su propio ID. Una apertura normal activa la primera vista existente; una nueva se inserta inmediatamente a la derecha de la seleccionada. Cerrar elimina solo la entrada local, nunca llama a borrar archivos o entidades.

El editor conserva su buffer y revisión observada mientras se navega por las pestañas. Solo la vista activa mantiene una instancia pesada de Milkdown/CodeMirror. Una escritura confirmada invalida las vistas limpias del mismo recurso; una vista con borrador conserva su base y el writer rechaza revisiones obsoletas. Una lectura que comenzó cuando la vista estaba limpia no puede reemplazar un buffer modificado antes de recibir la respuesta.

Milkdown serializa avisos con un debounce de 200 ms. Antes de suspender/guardar una vista, el adaptador drena las mutaciones DOM de la versión fijada de ProseMirror y toma la fuente solo si cambió el documento. Este acceso acotado a `domObserver.flush()` debe revalidarse al actualizar `@milkdown/prose` 7.22.3. Una selección o apertura sin edición no autoriza reserializar Markdown. Los borradores quedan en memoria del renderer de esa sesión; no se escriben en el archivo de restauración.

## Estado local y arranque

El host guarda JSON versionado en `userData/local-projects/workspace-sessions/<sha256(rootIdentity:projectId)>.json`, fuera de las carpetas portables. El catálogo tiene propietario único Windows. La sesión tiene revisión propia, un máximo de 100 pestañas y un límite de 256 KiB. Se valida su estructura exacta, IDs, números finitos, pertenencia al proyecto/raíz y revisión observada antes de sustituir el archivo mediante temporal sincronizado. Un JSON inválido, de otra identidad o de versión desconocida se conserva y diagnostica; no se transforma en una sesión vacía.

Se guardan orden, selección, modo visual/fuente/preview, posición de scroll y selección del editor por vista, y cámara local por workspace. No se guardan texto, permisos, session IDs de IPC, cookies, tokens OAuth ni nonce de estilos. Una copia clonada con el mismo UUID y otra identidad de carpeta tiene otra sesión local. Relocalizar la misma carpeta física mantiene su identidad; copiarla no la hereda.

`projects.json.resumeId` recuerda el reciente activo al salir. El arranque intenta reabrirlo únicamente con lectura local ya concedida. Una unidad ausente o permiso revocado conserva el reciente y muestra recuperación manual. Cerrar el proyecto explícitamente elimina `resumeId`, conservando sus pestañas para una apertura manual posterior. Cada apertura emite un session ID nuevo.

Las mutaciones de pestañas se confirman por IPC del host. Scroll/selección se agrupan durante 200 ms y se drenan al navegar, cerrar o cambiar de proyecto. El cierre nativo espera el drenaje local antes de liberar el escritor y consulta la guarda de borradores. El estado portable de cámara E2-A1 sigue usando su comando existente; la restauración local tiene prioridad para la vista y también permite conservar navegación de solo lectura sin escribir el proyecto.

## Guardado, recuperación y CSP

Cambiar de proyecto o cerrar una pestaña con borrador ofrece guardar, descartar o cancelar. Se guardan secuencialmente las vistas; si una falla por sintaxis, revisión o permisos, se conserva el proyecto y se activa la vista afectada. No hay atomicidad conjunta de todos los buffers: una vista ya confirmada puede quedar guardada aunque una posterior falle. El cierre nativo permite volver al editor para guardar o descartar explícitamente; una muerte del proceso no recupera texto que nunca llegó al writer.

Un Resource faltante abre diagnóstico con los IDs originales. «Ver referencia» muestra sus metadatos; «Localizar» usa el selector del host. Para un archivo interno ausente, la persona confirma un Markdown existente dentro del proyecto: se cambia únicamente path/revisión del descriptor, con broker, validación, hash/identidad del elegido y journal E1. Se rechazan escapes, exclusiones, rutas ya registradas, fuente original todavía existente, versiones no compatibles y conflictos. Los bytes seleccionados no se copian ni reemplazan. Si el descriptor falta, se informa de la necesidad de recuperarlo; no se inventa otro ID. Los montajes se relocalizan mediante aprobación local de su raíz y permanecen de solo lectura.

La CSP concede un nonce efímero exclusivamente a los estilos de los editores incluidos. El host lo inyecta en el HTML de `a3://desktop/index.html` y CodeMirror lo utiliza para sus hojas dinámicas. No se habilita JavaScript inline ni se guarda el nonce en el proyecto o la sesión.
