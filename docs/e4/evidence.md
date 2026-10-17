# E4 · evidencia consolidada

Cierre de evidencia E4-E1 sobre `codex/e3-e7-product`, desde E4-D1 `d6e87d5`. Los datos canónicos siguen siendo Entity/Resource y documentos de variables; listas, nodos, índices, exportaciones y contexto son proyecciones. Esta matriz declara el alcance comprobado de A3-018–023 y conserva límites de las entregas anteriores.

| Criterio | Evidencia y entrega | Límite vigente |
|---|---|---|
| A3-018 · variables | [Tipos/scopes](typed-variables.md), [resolución](variable-resolution-and-compilation.md), fixtures `fixtures/e4/variables/`, tests `variables.test.mjs` de dominio/store. Overrides, seis tipos, IDs estables, varias vistas, ciclos, ambigüedad, revocación y no reescritura global. | Solo bindings declarados; ejecución temporal no persiste. Credenciales no son variables y tipos/versiones desconocidos se diagnostican. |
| A3-019 · prompts | [Plantillas](prompt-templates.md), [contexto](prompt-context.md), fixtures `fixtures/e4/prompts/`, tests puros y `project-store/test/variables.test.mjs`. Helpers limitados, selección explícita, manifiesto de hashes/variables/omitidos, exclusión y división UTF-8 sin truncamiento, copia offline. | No envío a agentes/proveedores ni resultados IA inventados. Persistencia/versionado del catálogo de plantillas pendiente. El botón antiguo de descarga del compilador usa Blob y el shell bloquea `will-download`; exportación de archivo de ese panel requiere conectar un diálogo nativo. La exportación nativa de **checklists** sí se verifica en E4-E1 y es otro flujo. |
| A3-020 · historias/tareas | [Dominio](planning.md), [checklist y evidencia](checklists-and-evidence.md), fixtures `fixtures/e4/planning/`, pruebas dominio/store y smoke Electron `test:planning`. Historia/criterios con IDs, dependencias/ciclos, actor, evidencia, política antes de done; fila y nodos en dos vistas comparten Entity. | No se ejecuta la prueba citada como evidencia ni se certifica su verdad. Generación IA es borrador revisado; sin garantía de cobertura total. |
| A3-021 · intercambio | [Contrato E4-E1](checklist-exchange-and-traceability.md), fixture `checklist.md`, tests `checklist-exchange.test.mjs` de dominio/store y smoke Electron ampliado. Exportación Markdown, matching por ID, preview/diff, altas/cambios/conflicto, keep/import, referencia rota, sesión aislada, no-op, reapertura y guardado nativo con cancelación/colisión. | Formato A3 versionado, 128 tareas/256 KiB UTF-8 por lote; no matching por nombres ni importación sin metadata. Referencias deben existir en el proyecto. Sin sincronización continua, borrado por omisión o historia importada. |
| A3-022 · memoria aislada | [Memoria e índice](project-memory-search.md), pruebas `memory-search.test.mjs` y `variables.test.mjs`: dos proyectos, sesiones caducadas, fuentes explícitas, resúmenes con fecha/hash y memoria editable. E4-E1 rechaza checklist de otro `projectId` y no reutiliza tokens tras reabrir. | No se guardan chats como memoria automáticamente. No hay mezcla entre proyectos ni acceso externo sin concesión; resúmenes revisados manualmente, sin generación automática IA. |
| A3-023 · búsqueda | [Contrato de búsqueda](project-memory-search.md), fixture `fixtures/e4/memory/scenario.json`, pruebas de modificación/rebuild y exclusiones. Texto/título/etiquetas/código autorizado, montajes con grants y raíz vigente; índice reconstruible por sesión. | Índice en memoria, actualización de entradas incremental pero fuentes se releen para verificar hashes. Sin embeddings/API, búsqueda semántica ni recorrido completo de todos los montajes; límites/omisiones visibles. |

## Comprobaciones de esta entrega

Se ejecutan en Windows, Node 24.13.1 y Electron 44.7.2, con fixtures sintéticos y carpetas temporales. No se usan snapshots/documentos/credenciales del usuario ni llamadas a un proveedor de IA. Sin nuevas dependencias ni cambios de lockfile.

```powershell
npm run typecheck
npm run test --workspace @a3/domain
node --test packages/project-store/test/checklist-exchange.test.mjs packages/project-store/test/checklist.test.mjs packages/project-store/test/planning.test.mjs
node --test packages/project-store/test/variables.test.mjs packages/project-store/test/memory-search.test.mjs packages/project-store/test/security.test.mjs
npm run build --workspace @a3/desktop
npm run test:planning --workspace @a3/desktop
```

Resultado observado: **164/164 dominio**, **12/12 store planificación/intercambio**, **21/21 store variables/memoria/seguridad**, tipos y build aprobados. El smoke Electron emite `A3_PLANNING_SMOKE` y `A3_CHECKLIST_EXCHANGE_SMOKE` con sus escenarios. Se repiten las pruebas focalizadas tras cambios finales de formato/UI; no se afirma haber repetido todos los smokes históricos de E4.

El build conserva el aviso previo de chunks de diagramas mayores de 500 kB. No se prueba Linux, un instalador público, cortes eléctricos reales, escalas extremas, identidad visual entre SO o todos los controles en una revisión visual manual. E4 tiene evidencia del subconjunto anterior, y sus límites explícitos no se convierten en funcionalidades completas de la especificación.
