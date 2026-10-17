# E4-C2 · checklist, nodos de tarea y evidencia

Base: E4-C1 `b7ca4ac`, contratos Entity/Resource de E0, writer/broker E1, vista del canvas E2, A3 §16 y aceptación A3-020/021. No se añaden bibliotecas ni cambios de formato a los schemas E0.

## Vistas de la misma entidad

La pestaña Tareas ofrece lista y agrupación por historia o workspace, búsqueda por título/ID/responsable y filtros por estado, prioridad, historia y workspace. Una tarea con representaciones en dos workspaces tiene una sola identidad; aparece en ambos grupos de workspace con el mismo ID/revisión. Tareas sin representación o historia tienen grupo propio. La proyección se deriva del snapshot del store, sin catálogo paralelo persistido.

La pestaña crea historias con criterios propios y tareas asociadas opcionalmente a una historia. «Mostrar nodo en lienzo» crea una representación por workspace si no existe; repetir la acción activa la existente. El nodo y la fila usan `TaskControls` y `updatePlanningTask`: ambos leen/guardan la Entity canónica mediante `a3.planning.change`. Solo `done` marca la casilla; `todo`, `in_progress`, `blocked` y `cancelled` se muestran expresamente. Desmarcar propone `todo`.

Cada escritura espera confirmación del writer antes de mostrar un estado guardado nuevo. El host usa la identidad autenticada y su reloj, y los eventos de tarea incluyen `evidenceIds` además del estado anterior/nuevo. Se conservan eventos anteriores de E4-C1 sin inventarles evidencia histórica. Registrar una evidencia y vincularla a la tarea forma un lote lógico de dos documentos bajo el journal existente; no se promete atomicidad conjunta de archivos.

El nodo refresca el workspace tras escribir, incluidas otras representaciones locales. Abrir Tareas o volver al canvas recarga su modelo. Otras ventanas/vistas que aún tengan una revisión anterior reciben conflicto al guardar; no hay mezcla automática ni sobrescritura. «Recargar planificación» muestra el estado canónico actual mientras el borrador conflictivo se conserva hasta descartarlo explícitamente. Los borradores del formulario son de sesión y no se guardan como una segunda tarea; cambiar de sección/proyecto desmonta esos formularios. No se añade sincronización distribuida o notificaciones de cambios en tiempo real entre procesos.

## Evidencia y política

La fila y el nodo permiten elegir evidencias compatibles y registrar referencias `file/result/note/capture/commit` por ID. La persona selecciona título, origen y criterios. El host genera ID, actor y fecha; no acepta atribución desde el renderer. Los tipos y referencias se validan con E4-C1. Una referencia no certifica la veracidad de su contenido, la ejecución de un test ni la existencia de un commit remoto.

La opción de proyecto «Exigir evidencia vinculada antes de completar» guarda `extensions["a3.planning.policy"].requireEvidenceForDone`, por defecto `false`. Es una regla de validación compartible, no una concesión de capacidades. La configura una persona autenticada mediante `a3.planning.set-policy`, con revisión del manifiesto y `task.edit`; agente/extensión y comandos genéricos no pueden relajarla. La edición manual externa del manifiesto continúa bajo los diagnósticos/revisiones de E1; el JSON portable no es un registro firmado.

Si es `true`, cualquier comando que cree o modifique una tarea en `done` requiere al menos una evidencia vinculada válida. Política no interpretable bloquea completar. No exige una evidencia por cada criterio: esa diferencia sigue visible en el informe de criterios pendientes. Activarla no modifica retroactivamente tareas anteriores; al volver a editar una tarea ya completada también se verifica. El broker conserva `task.edit` para cambios y revocación antes de confirmar; colocar nodos requiere `diagram.edit`, leer `project.read`. Ningún borrador concede permisos.

## Pendientes y propuestas

El informe muestra historias/requisitos sin tarea y criterios sin evidencia válida vinculada mediante una tarea que use ese criterio. Las historias son requisitos explícitos; una entidad existente también se reconoce si declara `properties["a3.planning.requirement"]: true`. No se infieren requisitos del texto, de conexiones visuales ni de cercanía. La UI inicial crea historias; el marcador de otras entidades puede proceder de sus contratos/extensiones. Una evidencia suelta no cuenta como cobertura. Los indicadores son huecos trazables, nunca prueba de cobertura total; no comparan semánticamente una tarea con todos los requisitos.

«Revisar borrador de tareas de IA» acepta JSON declarativo con `schemaVersion`, `projectId`, `sourceRefs` y `items`; el ejemplo está en `fixtures/e4/planning/task-proposal.json`. Cada item tiene clave temporal, título, requisitos explícitos, criterios y dependencias por clave. No admite estados completados ni evidencia fabricada. Todas las fuentes/criterios/requisitos deben pertenecer al proyecto; los requisitos deben figurar entre las fuentes, y se rechazan ciclos y claves duplicadas.

Previsualizar no crea documentos. La persona puede editar el JSON, excluir tareas y aceptar la selección; si excluye una dependencia debe corregir la selección o el borrador. El host asocia token, hash SHA-256 del borrador, referencias y snapshot a la sesión. Un cambio posterior obliga a generar otra vista previa; no se acepta el mapping viejo sobre un modelo nuevo. Aceptar crea IDs UUID nuevos, remapea las dependencias internas y guarda procedencia `proposal.sourceHash/key/kind/coverageClaim:false`; las tareas empiezan `todo` y sin evidencia. El token se consume al confirmar y se elimina al cerrar/cambiar proyecto. Las propuestas sin aceptar permanecen solo en memoria de la sesión.

No hay llamada a un proveedor de IA en E4-C2: admite borradores preparados manualmente o por una IA externa y revisados aquí. A3-021 queda parcial: exportación Markdown con IDs e importación explícita de cambios/estados existentes pertenecen al bloque E4-E, y no se anuncian como implementadas por aceptar propuestas nuevas.

## Verificación y límites

Fixtures E4-C1 y propuesta E4-C2: pruebas puras para agrupación/filtros, una identidad en dos vistas, huecos de trazabilidad, política, atribución, ciclos y rechazo de propuesta ajena. Store temporal Windows: checklist→dos nodos, nodo→checklist, reapertura, conflictos/revocación y tokens ligados a sesión. Electron Windows: lista/búsqueda/agrupación, registro de evidencia, política aplicada en host, sincronización en ambos sentidos, conflicto con borrador conservado, preview/aceptación, IPC estricto y foco de teclado; renderer sin Node.

No se implementa un generador de IA ni export/import Markdown en este bloque. No se añade editor de todas las propiedades de planificación, autoasignación, ejecución de pruebas, cobertura semántica, undo/redo específico de tareas o actualización en vivo de otra instancia. Los controles nuevos y renderers usan el modelo existente, sin simular esas funciones.

Resultado observado en Windows: suite de dominio 160/160; conjunto dirigido `checklist/planning/security` del store 13/13; compilación desktop y tipos de main/preload/renderer aprobados; `npm run test:planning --workspace @a3/desktop` aprobado. El build conserva el aviso existente de chunks de diagramas mayores de 500 kB; no se genera instalador ni se verifica distribución. No se ejecutó la suite agregada completa de producto. La prueba funcional cubre UI y persistencia sobre carpetas temporales, no revisión visual de todos los tamaños de ventana.
