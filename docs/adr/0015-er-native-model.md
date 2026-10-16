# ADR 0015: modelo entidad–relación nativo

Estado: aceptado para E3-B2.

## Contexto

La especificación §§6 y 13.3 requiere tablas/campos, tipos, nulabilidad, claves y cardinalidades dentro de un modelo ER separado de UML. Los contratos E0-A ya proporcionan `Entity`, `Relation`, `Placement` y `RelationView`, además de propiedades namespaced y fallback para tipos desconocidos.

## Decisión

- Una tabla es un `Entity` `a3.er.table` con sus campos en `properties["a3.er"]`. Los campos y sus referencias usan UUID estables; FK referencia tabla y campo por ID, nunca por título.
- Una relación ER es `Relation` `a3.er.relationship`; sus extremos apuntan a IDs de tabla. Su aparición y geometría en un workspace viven en `RelationView`. No se convierte en `VisualEdge` ni en UML.
- Campos guardan tipo textual, nulabilidad, PK, FK y UNIQUE de una columna. La validación prohíbe PK nullable, IDs de campo repetidos, FK ausentes y destinos que no sean PK/UNIQUE. Las cardinalidades admitidas son `one`, `zero-or-one`, `many` y `zero-or-many`.
- El comando de host mantiene revisiones, broker, journal e historial compartido existentes. Cambiar título/nombre conserva IDs; una segunda vista reutiliza la misma entidad con otro placement.
- Mermaid ER se exporta únicamente para el subconjunto seguro declarado. El export contiene comentarios A3 con IDs estables de tabla, campo y relación, conserva tipos admitidos, claves, nulabilidad y cardinalidad; cualquier fragmento inseguro o referencia fuera del subconjunto devuelve diagnóstico y no código parcial.
- Versiones futuras y tipos no reconocidos permanecen opacos y usan el fallback existente; este módulo no los reescribe ni interpreta.

## Consecuencias y límites

No hay importador Mermaid en este bloque; §14.2 reserva la conversión para el adaptador Mermaid. Se soporta UNIQUE por campo, no grupos de unicidad compuesta; una FK referencia una columna, no una tupla compuesta. Las reglas y dialectos de tipos permanecen como texto: el exportador solo admite el patrón Mermaid validado y no valida motores SQL. No se genera SQL ni se aplican restricciones a datos reales. Ver también la [sintaxis ER Mermaid](https://mermaid.js.org/syntax/entityRelationshipDiagram.html).
