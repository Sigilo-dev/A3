# E5-D1/D2: herramientas A3 y revisión de propuestas

Implementación basada en la especificación §§8/20/21, el broker E1-E1, el journal E1-D1 y los contratos E5-C2. Véase [ADR 0023](../adr/0023-scoped-a3-agent-tools.md).

## Scope y lectura

`@a3/project-store` publica `A3_TOOL_SCHEMAS`, `describeA3Tools()` y `ProjectAgentTools`. `LocalProjectManager.createA3ToolSession()` fija la sesión activa, proyecto, identidad física de la raíz y selección de IDs. El transporte no acepta actor, proyecto, raíz, rutas, capability ni scope alternativo.

| Herramienta | Resultado | Permiso y límite |
|---|---|---|
| `get_project_context` | Metadatos e IDs seleccionados | `project.read` |
| `query_entities` | Búsqueda entre entidades seleccionadas | `project.read`, hasta 20 resultados |
| `query_memory` | Fragmentos de memoria con ID/revisión/hash | `project.read`, hasta 64 fuentes y 256 KiB por fuente |
| `read_resource` | Texto por ID y revisión, con hash/procedencia | Broker y `ProjectService`; 256 KiB; deniega binarios, URL y rutas con nombres sensibles |
| `validate_changes` | Preview de un lote de hasta 32 cambios de título/etiquetas | No escribe; requiere scope leído. Crea un plan solo en memoria y repite validaciones al aplicar |
| `apply_changes` | Revalida y aplica una propuesta pendiente | Reautorización efectiva, revisión/hash vigentes y journal E1 |
| `cancel_changes` | Descarta una propuesta pendiente | No escribe |
| `undo_changes` | Restaura los campos de una propuesta aplicada | Nueva transacción, revisión resultante esperada y journal E1 |

La validación acepta propuestas en los perfiles Consultar y Proponer sin conceder `document.edit`. Aplicar en Consultar se deniega. Proponer solicita aprobación efectiva a la persona; el diálogo nativo presenta herramienta, capacidad, IDs afectados, revisiones y diff. Trabajar aplica solo cuando el broker calcula una concesión efectiva directa. Un override denegado sigue prevaleciendo.

Los cambios se limitan a `title` y `tags` de entidades no planificadoras seleccionadas. El nuevo comando de dominio `a3.core.update-entities` permite 1–32 IDs distintos y los serializa como una operación lógica de varios archivos. Cada revisión esperada se valida de nuevo dentro del writer; un conflicto preserva la propuesta y no aplica parcialmente el lote. La operación de varios archivos no se declara atómica.

`undo_changes` crea otra operación con nuevos números de revisión. Si una escritura externa o posterior cambió cualquier entidad después de aplicar, devuelve conflicto y mantiene esos bytes. El recibo contiene `atomic: false`, paths relativos y snapshot ID; nunca una ruta raíz.

Copiar texto no llama a herramientas mutables. No existe `update_task` en este contrato, por lo que ninguna copia puede marcar una tarea como completada.

## Estado y límites

Las propuestas y sus diffs pendientes viven en memoria de la sesión host. Cancelar o aplicar mantiene el estado durante esa sesión; cerrar la aplicación las descarta. Tras una interrupción durante un write, E1-D1 recupera el journal de forma determinista; E5-D2 no reejecuta una operación incierta. No se persiste el cuerpo de una propuesta pendiente en el registro de turnos ni se restaura el undo disponible tras reiniciar. Un lote recuperado se inspecciona como estado del proyecto y cualquier acción posterior requiere una propuesta nueva.

El commit y el undo del agente usan el snapshot/journal existentes de `ProjectService`. No agregan un journal paralelo. El test de corte termina el proceso después de instalar un archivo de un lote; al reabrir, E1-D1 revierte el conjunto y conserva el contenido inicial. Esto demuestra recuperación del proceso ante ese punto de fallo, no durabilidad frente a pérdida eléctrica.

No hay registro de herramientas en MCP/app-server, ejecución desde una inferencia real, UI de historial de propuestas ni herramienta de tarea. E0-B2 no verificó el transporte de herramientas y E5-C2 rechaza solicitudes de herramientas iniciadas por el servidor. Los esquemas siguen disponibles solo al host de A3 y pruebas.

La redacción de secretos detecta patrones conocidos y no garantiza reconocer cualquier secreto escrito como texto. El renderer no recibe tokens ni rutas absolutas.

## Verificación

```text
npm run build --workspace @a3/domain
node --test packages/domain/test/commands.test.mjs
npm run build --workspace @a3/project-store
node --test packages/project-store/test/agent-tools.test.mjs
npm run typecheck --workspace @a3/desktop
```

Las pruebas dirigidas cubren A3-031/032/033, denegación de capacidades, preview sin escritura, aprobación cancelada, lote multiarchivo válido, conflicto de revisión/hash sin aplicación parcial, undo como segunda transacción y recuperación de journal después de corte de proceso (A3-046). No se ejecutaron tools mediante Codex app-server ni MCP.
