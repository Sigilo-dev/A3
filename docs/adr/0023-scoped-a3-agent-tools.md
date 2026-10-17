# ADR 0023: herramientas A3 acotadas y propuestas revisables

Estado: aceptada para E5-D1/D2. Base: E5-C2 `1b3c87e`, especificación §§8/20/21 y criterios A3-031–033/046. Reutiliza el broker E1-E1, `ProjectService` y el journal E1-D1.

## Decisión

El proceso principal vincula las herramientas a una sesión `LocalProjectManager`, el UUID del proyecto, identidad física de la raíz y conjuntos explícitos de UUID para entidades, recursos, relaciones, workspaces y memoria. Cada llamada verifica la sesión y solicita `project.read`. No se aceptan actor, proyecto, raíz, rutas ni capabilities desde el agente.

`validate_changes` prepara solo título/etiquetas para hasta 32 entidades no planificadoras dentro del scope. El comando de dominio de lote valida IDs, tipos, revisiones y scope. La propuesta entrega diff, entidad afectada, revisión esperada/resultante, capacidad efectiva, hash de fuente y estado. Preparar no persiste. El plan PreparedWrite no sale del proceso principal.

`apply_changes` usa el mismo `ProjectService.commit()` y journal E1. El writer vuelve a verificar sus archivos, revisión, hash y permiso al aplicar. Proponer debe obtener aprobación explícita del broker; el diálogo nativo muestra herramienta, permiso, entidades, revisiones y diff. Trabajar solo aplica si el broker concede capacidad directa. Consultar permite inspeccionar pero deniega el commit. Cancelar no crea escrituras. El conflicto conserva propuesta y estado durante la sesión y no modifica parcialmente el lote.

`undo_changes` no restaura bytes en crudo. Crea otra propuesta de dominio con los campos previos y la revisión producida por el commit; pasa por el mismo broker, snapshot y journal. Una edición posterior invalida la precondición y el undo se detiene sin pisarla. La operación lógica de varios archivos no es atómica.

El estado de propuesta y el dato requerido para el undo viven en memoria host por sesión. Después de reiniciar, el journal E1 recupera transacciones interrumpidas y E5-D2 no las vuelve a ejecutar; el undo del agente requeriría una nueva propuesta explícita. No se duplica el journal de E1.

## Consecuencias y límites

No hay herramienta `update_task`, operación de portapapeles mutable, ejecución de código, shell, red, paquetes, Git, exportación o borrado en este conjunto. Copiar texto por UI no cambia datos ni estados de tareas. Los patrones de redacción no identifican todo secreto arbitrario en texto. Los providers no reciben tokens ni rutas absolutas.

Las herramientas no se registran en MCP/app-server ni se llaman desde una inferencia real: E0-B2 no verificó el transporte de herramientas y E5-C2 rechaza solicitudes de herramientas iniciadas por el servidor. El código entrega contratos y una ruta de revisión/aplicación solo al host A3.

## Evidencia

`packages/domain/test/commands.test.mjs` cubre un lote de entidades válidas y miembros duplicados. `packages/project-store/test/agent-tools.test.mjs` cubre A3-031/032/033: preview, aprobación cancelada, permisos Consultar/Proponer/Trabajar, lote aplicado y deshecho mediante dos transacciones, conflicto de hash/revisión externa sin aplicación parcial y corte de proceso después de instalar un miembro, seguido de rollback E1-D1 al reabrir. Esa prueba de proceso no representa corte eléctrico ni conecta Codex a las tools.
