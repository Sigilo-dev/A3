# E4-B2 · contexto explícito y compilación trazable

Implementa A3 §15.3 y los criterios A3-019/A3-022 junto con la compilación de variables de E4-A2 y las plantillas seguras E4-B1.

## Alcance elegido

El panel de prompts presenta un catálogo del proyecto activo. La persona puede incluir una entidad como selección, requisito o criterio de aceptación, elegir recursos textuales —incluidos recursos bajo `memory/`— y seleccionar relaciones semánticas por ID. Un nodo entidad incluye su propio recurso de contenido asociado; los extremos de una relación no amplían la selección. `VisualEdge` no aparece en el catálogo de relaciones ni puede añadirse a la petición como relación semántica.

La selección vive en la petición de compilación. No se infiere contexto por vecindad, grupos, conexiones visuales, backlinks ni relaciones no marcadas. La memoria se ofrece como fuentes explícitas; esta etapa no decide automáticamente qué archivos son “relevantes”. El workspace/entidad elegidos proporcionan el contexto de resolución de variables.

## Lectura y presupuesto

Las lecturas pasan por `ProjectService.openResource` y el broker del proyecto. No se inicia red para URLs. Se admiten fuentes textuales conocidas con UTF-8 válido; recursos binarios, URLs remotas, JSON inválido, rutas no disponibles y revisiones en conflicto quedan como omisiones diagnosticadas. El lector limita un recurso a 8 MiB y el conjunto de lecturas de recursos a 32 MiB por compilación. La selección admite hasta 128 entidades, 128 recursos y 128 relaciones.

El presupuesto de salida se mide en bytes UTF-8 por parte; el valor inicial es 64 KiB y el rango disponible es 4 KiB–1 MiB. El bloque de plantilla y encabezados cuenta dentro del presupuesto. Sin división, una fuente que no cabe se omite completa. Con división, la fuente se reparte en fragmentos UTF-8 completos y ordenados entre partes; cada parte repite la plantilla y cumple el mismo límite. No se descartan bytes de una fuente seleccionada sin consignar su omisión en el manifiesto.

Cada parte marca el ID, categoría, ruta relativa, revisión y SHA-256 de cada origen. El preview añade el tamaño original y el tamaño aportado al contexto. Las fuentes que no se pudieron leer incluyen motivo y, si se pudo verificar, hash/revisión. Variables listan nombre, ámbito efectivo y valor tipado resuelto; las referencias con diagnóstico se mantienen visibles. Las líneas exportadas son Markdown plano delimitado; A3 no evalúa HTML, código, ni instrucciones de la fuente.

## Trazabilidad local

Cada compilación guarda un registro JSON en `.a3/local/prompt-runs/<uuid>.json`, área excluida de Git. El registro incluye ID y proyecto, modo, hash de plantilla, hash de entradas, hash de la salida por partes y total, referencias de selección, manifiestos incluidos/omitidos, valores tipados efectivamente resueltos con ámbito y hash, y marca de tiempo. No guarda el contenido de fuentes, salida completa, valores originales de entradas ni credenciales. Los valores resueltos quedan en el área local del proyecto y pueden contener texto del proyecto. `provider` y `model` son `null`: esta etapa no envía prompts ni registra resultados de IA.

Copiar y exportar funcionan localmente sin IA. Si el usuario dividió el contexto, se copia/exporta una parte por acción. Los valores obligatorios de variable sin resolver siguen bloqueando uso automático; omisiones no revisadas y compilaciones multiparte también bloquean esa autorización.

## Fixtures, validación y límites

`fixtures/e4/prompts/context-cases.json` y `packages/domain/test/prompt-context.test.mjs` cubren manifiesto/origen, fuentes omitidas, exclusión explícita, límite exacto, división UTF-8, ausencia de truncamiento, aristas visuales fuera del modelo y aislamiento de proyecto. `packages/project-store/test/variables.test.mjs` usa proyectos temporales para verificar selección IoT por ID, exclusión explícita, lecturas con hashes, valores variables resueltos en la traza local, relación semántica explícita, rechazo de un ID de `VisualEdge` usado como relación y separación entre proyectos. `apps/desktop/test/variables-smoke.cjs` comprueba el selector, preview/manifiesto y el puente seguro en Electron.

Cobertura: A3-019 (compilación local, manifiesto, exclusión/división y exportación Markdown) y A3-022 (no compartir información entre proyectos); variables de A3-018 conservan la resolución tipada de E4-A1/A2. No se declara completo A3-019: no existe envío a Codex/otro agente, selector directo sincronizado con la selección viva del lienzo, ranking/recolección automática de memoria, historial navegable de trazas ni limpieza/retención de registros. Las fuentes grandes no se transforman ni sintetizan; se dividen o quedan omitidas con diagnóstico.
