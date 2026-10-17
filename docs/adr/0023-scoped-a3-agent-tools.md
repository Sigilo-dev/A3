# ADR 0023: contratos de herramientas A3 con scope de proyecto

Estado: aceptada para E5-D1. Base: E5-C2 `1b3c87e`, especificación §§20.4–20.7/21 y criterios A3-031–033. Reutiliza el broker E1-E1, `ProjectService` y el índice/memoria E4-D1; no agrega permisos.

## Contrato y scope

El proceso principal vincula las herramientas a la sesión de un `LocalProjectManager`, el UUID del proyecto, identidad física de la raíz y conjuntos explícitos de UUID para entidades, recursos, relaciones, workspaces y recursos de memoria. Al abrir otra sesión, la binding anterior queda inválida. La factory comprueba que los IDs existen en el snapshot del proyecto activo, que ambos extremos de cada relación están seleccionados y que la búsqueda de memoria solo incluye Markdown en `memory/`. Los argumentos de herramienta no pueden contener `projectId`, raíz, rutas, actor ni capacidades.

Las herramientas iniciales son `get_project_context`, `query_entities`, `query_memory`, `read_resource` y `validate_changes`. Sus esquemas JSON son estrictos (`additionalProperties: false`) y el parser repite las validaciones en runtime. Los límites son 64 KiB por solicitud, 512 KiB por respuesta, 256 KiB por recurso leído, 64 documentos de memoria y 20 resultados de búsqueda. Respuestas de lectura contienen IDs, revisiones, hashes y contenido textual permitido; nunca rutas absolutas. Campos de entorno y patrones conocidos de tokens se redactan al devolver texto.

Cada llamada comprueba que la sesión sigue activa y solicita `project.read` al broker sellado. `read_resource` vuelve a pasar por `ProjectService.openResource`, que aplica capacidades de lectura y resolución de rutas. `validate_changes` acepta solo cambio de título y etiquetas de una entidad ya seleccionada, construye el actor desde el host, incluye `expectedRevision`, y usa `ProjectService.prepare` para validar el comando y su permiso. Devuelve un diff y hash de procedencia; no guarda ni genera un token de aplicación. Las revisiones obsoletas producen conflicto. La aplicación futura debe volver a autorizar y revalidar bajo el writer/journal.

Ninguna herramienta ejecuta código, shell, red, paquetes, Git, exportación o borrado. No existe `apply_changes` en este contrato ejecutable.

## Transporte y límites

E0-B2 comprobó solo el handshake `initialize` del app-server y no validó un canal de herramientas ni una versión de MCP. E5-C2 cierra las solicitudes de herramientas iniciadas por el servidor. Por tanto, los contratos están disponibles únicamente para el host confiable y pruebas; no se anuncian ni registran en MCP o app-server hasta validar un protocolo/adaptador exacto. La interfaz manual de ChatGPT tampoco llama a estas funciones.

La redacción de secretos es una defensa para patrones conocidos; no identifica valores secretos arbitrarios escritos dentro de cualquier documento. Los tokens del proveedor no están en el proyecto ni se pasan a estas herramientas. El scope todavía lo debe escoger una interfaz de preferencias del proyecto antes de habilitar un proveedor. Los cambios editables de propiedades, tareas, diagramas y archivos quedan para contratos posteriores con sus capacidades específicas.

## Evidencia

`packages/project-store/test/agent-tools.test.mjs` verifica contextos acotados, búsqueda de memoria, lectura por ID, redacción, ID extranjero, cambio de sesión/proyecto, esquema desconocido, límite de tamaño, revisión válida/obsoleta, propuesta sin escritura y denegación estructurada del broker. Estas pruebas cubren la capa de contrato E5-D1; no prueban conexión de herramientas con una inferencia real.
