# E3-A1: diagramas conceptuales

## Contrato implementado

Basado en `A3_ESPECIFICACION_MAESTRA.md` §§6 y 13.1 y en los contratos E0-A de dominio, comandos y extensiones.

- Los ocho tipos iniciales son entidades A3 con tipos estables `a3.conceptual.{concept,idea,note,decision,question,cause,result,reference}@1.0.0`. Su título, propiedades, puertos y extensiones siguen siendo contenido canónico de la entidad.
- Un tipo con otra versión no se interpreta como uno de estos renderers incorporados; conserva sus datos y queda disponible para el fallback de tipo ausente.
- Una relación conceptual es un `Relation` semántico `a3.conceptual.relationship@1.0.0`. Su etiqueta se guarda en `properties["a3.conceptual.label"]`; el tipo opcional (`composition`, `dependency`, `cause` o `association`) se guarda en `properties["a3.conceptual.kind"]`. La categoría se puede quitar sin perder la etiqueta ni propiedades desconocidas.
- Cada relación creada desde un workspace tiene un `RelationView` con extremos por `placementId`. Las posiciones y representaciones siguen siendo locales a cada workspace; la relación semántica conecta las entidades canónicas.
- `VisualEdge` sigue representando únicamente organización visual. Las relaciones conceptuales se cargan y dibujan por separado y no se convierten en líneas organizativas.
- El validador limita los extremos de esta familia a nodos conceptuales. No impone cardinalidad ni prohíbe autoenlaces o ciclos. Los tipos de otras familias, incluido C4, quedan fuera de este bloque.

Los comandos de dominio crean y actualizan nodos y relaciones, y eliminan una relación junto con sus vistas. Validan IDs, etiquetas, familia de extremos, pertenencia al workspace y revisiones en el host. Las ediciones conservan campos y propiedades namespaced desconocidos. La interfaz ofrece creación e inspección de nodos, edición de etiqueta/tipo, y eliminación sujeta al broker del proyecto.

## Criterios relacionados

| Criterio | Relación y evidencia de este bloque | Límite de cobertura |
|---|---|---|
| A3-006, Lienzo | Parcial: crea y selecciona placements conceptuales persistentes, dibuja relaciones semánticas dirigidas y las guarda por workspace. Prueba store y flujo Electron con fixtures. | No cubre todo A3-006 (alineación, grupos, resize, historial integral ni accesibilidad completa). |
| A3-052, Accesibilidad | Aplicación parcial: el inspector usa controles HTML etiquetados, formularios y botones operables por teclado. | No se hizo auditoría de foco, escala, nombres accesibles ni recorrido completo por teclado. |
| A3-004, Varias vistas de una entidad | Compatible con la separación `Entity`/`Placement`: el tipo/título pertenece a la entidad y cada vista referencia su ID. | Este bloque no añade un test de dos workspaces ni afirma completar A3-004. |

## Verificación

- `node --test packages/domain/test/conceptual-diagrams.test.mjs`: invariantes de los ocho tipos, ciclo y autoenlace, separación `Relation`/`RelationView`/`VisualEdge`, edición con revisiones y rechazo de extremos ajenos.
- `node --test packages/project-store/test/conceptual-diagrams.test.mjs`: creación/edición/eliminación con persistencia, conflicto de revisión y conservación de líneas visuales.
- `npm run test:conceptual --workspace @a3/desktop`: flujo Electron aislado con el fixture E0-A; verifica inspector, relaciones etiquetadas en ciclo, render separado y actualización del nodo.

No se incluyen renderers especializados para mapas mentales o de flujo, auto-layout, exportación/importación de lenguajes, paquetes comunitarios ni C4/UML/IoT. Se conservan las primitivas semánticas para que esos bloques puedan añadir sus reglas familiares sin reinterpretar `VisualEdge`.
