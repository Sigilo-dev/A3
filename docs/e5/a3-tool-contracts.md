# E5-D1: contratos de herramientas A3 con scope

Implementación del bloque: [ADR 0023](../adr/0023-scoped-a3-agent-tools.md), basado en §§20.4–20.7/21, broker E1-E1 y memoria E4-D1.

## Herramientas disponibles al host

El paquete `@a3/project-store` publica `A3_TOOL_SCHEMAS`, `describeA3Tools()` y `ProjectAgentTools`. `LocalProjectManager.createA3ToolSession()` crea la instancia únicamente para la sesión activa del host. La binding fija proyecto, identidad de raíz y listas explícitas de IDs. Los argumentos no aceptan actor, proyecto, ruta, root, capability o scope alternativo.

| Herramienta | Resultado | Capacidad y límite |
|---|---|---|
| `get_project_context` | Nombre/revisión del proyecto y solo IDs seleccionados | `project.read` |
| `query_entities` | Busca título/tipo/tags entre IDs seleccionados | `project.read`, hasta 20 resultados |
| `query_memory` | Fragmentos de Markdown de memoria elegida, con ID, revisión y hash | `project.read`, hasta 64 fuentes y 256 KiB por fuente |
| `read_resource` | Texto por `resourceId` y `expectedRevision`, con hash/procedencia | Broker y `ProjectService`; 256 KiB máximo; rutas secretas, binarios, URLs remotas y archivos de credenciales se deniegan |
| `validate_changes` | Diff de título/tags, revisión siguiente propuesta y hash fuente | `document.edit` en etapa de preparación; no persiste |

Todos los objetos rechazan propiedades no declaradas. El tamaño de llamada se limita a 64 KiB y el resultado a 512 KiB. La lectura redacta líneas que parecen contener claves y patrones conocidos de tokens. Las rutas no salen en respuestas. Los IDs y revisiones se validan y no bastan para conceder permiso.

`validate_changes` requiere UUID de operación, UUID de entidad seleccionada, revisión esperada y un patch no vacío. El comando actor se toma del host. El dominio y el broker vuelven a validar autorización, scope y revisión; el resultado declara `persisted: false`. Títulos y tags son el único subconjunto inicial editable mediante esta herramienta.

## Verificación

Desde la raíz del repo:

```text
npm run build --workspace @a3/project-store
node --test packages/project-store/test/agent-tools.test.mjs
```

La suite cubre A3-031/032/033 en el nivel de contrato: lectura permitida, IDs fuera de scope, cambio de proyecto, entradas inválidas, denegación con capacidad faltante, diff de revisión válida, conflicto de revisión obsoleta y bytes originales sin cambios.

## Estado de integración

E0 no verificó MCP ni un método del app-server para entregar llamadas locales; el handshake probado fue `initialize`. E5-C2 también rechaza solicitudes iniciadas por el servidor. Estas definiciones no están registradas en MCP/app-server, no se invocan desde inferencia y no exponen un canal al renderer. A3-031/032 tienen cobertura local de contrato y broker; A3-033 solo comprueba la validación del diff, no la aplicación de un lote ni su commit. La ruta de aplicación requiere aprobación y conexión a los recibos transaccionales E5-D2.

La redacción es heurística: no hay forma de detectar todo secreto arbitrario pegado como texto. Las credenciales OAuth no forman parte del proyecto ni del objeto host. La selección visible de scope por proyecto, herramientas de tareas/diagramas, exportación, Git y ejecución siguen fuera de este bloque.
