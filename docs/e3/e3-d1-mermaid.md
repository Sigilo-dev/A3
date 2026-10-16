# E3-D1: fuente Mermaid preservada y vista renderizada

Base aceptada: E3-C2 en `codex/e3-e7-product`. Fuente: especificación §§14.1–14.4, spike [E0-D2](../e0/compatibility/diagram-engines.md), contrato E0-A y decisión [ADR 0016](../adr/0016-mermaid-source-renderer.md).

## Contrato

El tipo de entidad `a3.diagram.mermaid@1.0.0` guarda la autoridad explícita en `properties["a3.diagram.authority"] = "source"`, el formato Mermaid y el perfil `mermaid@12.2.0`. El cuerpo canónico permanece en un Resource UTF-8 `.mmd`; también se puede crear un nuevo Resource desde texto o referenciar un Resource local/montado `.mmd` o `.mermaid`. En el segundo caso el nodo reutiliza el mismo Resource ID y no copia ni reescribe sus bytes.

La vista ejecuta solo el parser/renderizador fijado. Un parser error presenta línea/columna cuando Mermaid las proporciona y un fallback con la fuente completa. También hay fallback para paquete/chunk ausente, perfil de renderer desconocido, recurso no legible y fuentes mayores al límite del render. No se cambia autoridad ni fuente a causa del render.

Mermaid `12.2.0` queda fijado con licencia MIT, verificada en el lock E0-D2 y el paquete fijado. DOMPurify `3.4.17` queda fijado como sanitizador directo del SVG, con licencia dual `(MPL-2.0 OR Apache-2.0)` registrada en el lock. El motor se carga de forma diferida al hacerse visible el nodo. Usa `securityLevel: strict`, `htmlLabels: false`, sin `startOnLoad`, sin `bindFunctions`, tema `default`, límite de fuente 128.000 caracteres y máximo 500 aristas. El SVG se sanitiza con el perfil SVG, se eliminan elementos HTML/activos, imágenes y referencias `href`; estilos con URL/import se descartan.

El host permite leer hasta 1 MiB para la previsualización Mermaid. El renderer solo procesa hasta 128.000 caracteres. Ninguna acción ejecuta scripts, HTML, plugins o click handlers de la fuente. El render no extrae un AST ni convierte a C4, UML, ER o relaciones A3. La autoridad `a3-model` no pasa por este renderer.

## Cobertura y límites

| Criterio | Evidencia en E3-D1 | Límite |
|---|---|---|
| A3-015 | Conserva el Resource completo; render válido; error sintáctico localizado; fallback conservador; referencia de fuente existente sin duplicarla. | No importa PlantUML/Structurizr ni ofrece conversión Mermaid→A3. |
| A3-016 | Renderer, versión y tema default quedan fijados para reproducir la misma configuración. | Falta referencia visual aprobada y comparación pixel/tema; no se declara fidelidad universal ni cobertura completa. |
| A3-017 | El nodo mantiene una representación SVG segura en preview. | Exportar selección/grupo/workspace como SVG/PNG/PDF queda fuera de este bloque. |

Mermaid C4 sigue siendo experimental según E0-D2. Las capacidades reales dependen de la gramática Mermaid `12.2.0`; no se anuncia soporte universal de todas las sintaxis, extensiones o temas. No se ejecuta un parser independiente con AST para esta versión porque E0-D2 encontró que rechazaba class y C4.

## Pruebas

- `npm run test:mermaid --workspace @a3/desktop`: autoridad y versión, fixtures válido/inválido, línea del error y fallback al fallar la carga del renderer.
- `npm run build --workspace @a3/desktop`: tipos y bundle con dependencias fijadas.
- `npm run test:mermaid:smoke --workspace @a3/desktop`: creación con autoridad `source`, igualdad del texto leído, referencia de Resource existente, render de fixture, error de línea 2, y rechazo de etiquetas/scripts/eventos/URL del SVG resultante.

Fixtures: [`flowchart.mmd`](../../fixtures/e3/mermaid/flowchart.mmd) y [`invalid.mmd`](../../fixtures/e3/mermaid/invalid.mmd).
