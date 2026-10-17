# E4-C1 · historias, criterios, tareas y evidencias

Contrato de dominio de A3 §16, con cobertura parcial de A3-020. Usa Entity/Resource, UUID, revisión por documento y comandos del host ya aceptados en E0/E1. No introduce otro catálogo ni estado de UI. No añade dependencias ni modifica schemas E0.

## Modelo portable 1.0.0

Los tipos `a3.planning.story`, `a3.planning.task`, `a3.planning.criterion` y `a3.planning.evidence` usan `typeVersion: 1.0.0`. Cada uno es una Entity global bajo `.a3/entities/<id>.json`; título, ID, revisión, tags y extensiones siguen el contrato existente. Sus datos tipados están en `properties["a3.planning"]`, discriminados por `kind`. Un `contentResourceId` opcional referencia la descripción Markdown canónica; ausencia significa que todavía no hay descripción. El texto no se copia dentro del JSON ni en las vistas.

| Familia | Datos específicos |
| --- | --- |
| Historia | Actor de la necesidad (texto), necesidad, objetivo, prioridad, `criterionIds`, `dependencyIds`, referencias tipadas. Este actor de negocio es distinto del actor autenticado que edita. |
| Criterio | Entity con ID propio, título, descripción Markdown por recurso, `storyId` y referencias. Historia y criterio se referencian mutuamente. |
| Tarea | Estado `todo/in_progress/blocked/done/cancelled`, prioridad, responsable opcional, `storyId` opcional, dependencias de otras tareas, criterios y evidencias por ID, referencias. |
| Evidencia | Destino tipado, criterios vinculados, actor autenticado de registro y fecha de origen. El destino y la atribución inicial son inmutables; para otro origen se crea otra evidencia. |

Prioridades iniciales: `low`, `normal`, `high`, `critical`; son etiquetas sin ordenación automática. Las referencias resuelven entidades, recursos, relaciones semánticas y workspaces por ID del mismo proyecto. Renombrar conserva los IDs. La dependencia historia→historia o tarea→tarea debe existir y no formar ciclos; las líneas visuales no participan. Un bloqueo no se deduce de la mera existencia de una dependencia: el estado sigue siendo explícito.

Destinos de evidencia: `file`/`capture` apuntan a `resourceId`; `result`/`note` a `entityId`; `commit` a `repositoryResourceId` y hash completo de 40 o 64 dígitos hexadecimales. Se comprueba existencia de la referencia, no que el archivo sea una captura auténtica, que un resultado haya pasado o que el commit exista en Git. Los fixtures usan evidencia sintética. Una evidencia puede vincular varios criterios; todos deben existir y, al asignarla a una tarea, pertenecer a los criterios de esa tarea. Registrar evidencia no demuestra por sí solo cobertura ni corrección.

## Comandos, historial y permisos

`a3.planning.change` recibe `occurredAt` UTC y un lote de 1–128 operaciones `create`/`update`; un mismo ID no se edita dos veces en el lote. La historia y sus criterios pueden crearse juntos. Crear recibe ID, título, datos y referencia Markdown opcional. Actualizar recibe ID, revisión esperada, título y datos completos de los campos conocidos; `contentResourceId` permite enlazar una descripción existente, `null` quitar su referencia sin borrar bytes y omitirlo conservarla. Se conservan campos desconocidos de la Entity, propiedades, responsable, referencias y datos de planificación; omitir responsable o historia elimina esos campos opcionales de una tarea.

El kernel toma el actor del envelope autenticado por el host (`user` representa persona, `agent` o `extension`). No acepta atribución de evidencia dentro del payload. Cada edición añade un evento en `properties["a3.planning.history"]` con ID de operación, actor, fecha y acción; las tareas incluyen estado anterior/nuevo y validan la continuidad de la secuencia. La fecha es un dato explícito del comando que debe proporcionar el adaptador confiable usando su reloj. El historial no es una firma criptográfica frente a edición externa de archivos.

Las revisiones, scope y autorización se validan con el kernel común. Volver a preparar un ID de evento ya registrado devuelve conflicto, sin duplicar actividad; reconfirmar el mismo plan usa el comportamiento idempotente existente del writer. Cambios de planificación requieren `task.edit`, incluso mediante comandos genéricos o borrado; se revalida al confirmar para que revocar afecte la siguiente operación. Operaciones de colocación y Markdown conservan sus capacidades habituales. El kernel rechaza edición/creación de entidades de planificación mediante comandos genéricos: los cambios auditados deben usar `a3.planning.change`. El borrado usa la operación existente con `delete` y `task.edit`, y falla si deja referencias inválidas.

El lote se confirma mediante writer/journal E1. Es una operación lógica de varios archivos, sin promesa de atomicidad conjunta. JSON desconocido se conserva; versiones de tipo futuras quedan opacas para el modelo de planificación y pueden mostrarse por fallback. Corrupción semántica conocida genera diagnóstico y conserva los bytes originales.

## Evidencia y límites

`fixtures/e4/planning/records.json` contiene documentos portables con una historia, criterio, dos tareas, cinco clases de evidencia y un recurso de captura sintética. `scenario.json` fija IDs de referencia; `planning-capture.svg` aporta los bytes del recurso. Las pruebas de dominio comprueban estados, actores, criterios, ciclos/DAG, referencias, revisiones, atribución y preservación. Las pruebas del store usan solo carpetas temporales: creación por journal, modificación, reapertura, denegación/revocación y bytes de Markdown intactos, corrupción localizada y versión futura.

E4-C1 entrega dominio y persistencia para A3-020. E4-C2 añade lista/checklist, renderer de tarea, agrupación/filtros, sincronización nodo-fila, propuestas y política de evidencia obligatoria antes de `done`; sus contratos y límites están en [checklists-and-evidence.md](checklists-and-evidence.md). Se aceptan transiciones entre los cinco estados, sin inferir terminación desde dependencias ni ejecutar herramientas. La creación de descripciones nuevas usa los servicios de Resource existentes; este comando solo enlaza sus IDs. Duplicación de contenido y undo/redo específico de planificación necesitan su integración futura; las representaciones siguen compartiendo la misma Entity.

Comprobaciones Windows de esta entrega: suite completa de dominio, 156/156; conjunto dirigido del store (`planning`, `security`, `reader`, `codec`, `writer`), 84/84; `npm run typecheck` de todos los workspaces. Las pruebas del writer incluyen interrupciones de proceso y recuperación E1: no acreditan pérdida física de energía. No se ejecutó la suite agregada completa de producto ni aceptación visual de checklist, que queda en E4-C2.
