# ADR 0017: importador Mermaid de subconjunto estricto

Fecha: 2026-10-16. Alcance: E3-D2, especificación §§14.1–14.2 y criterio A3-015; sucesor de [ADR 0016](0016-mermaid-source-renderer.md).

## Decisión

Se convierte solo una gramática de líneas explícita para flowchart, class y ER. El renderer Mermaid no se utiliza como prueba de soporte de la conversión. Toda la fuente permanece en su Resource; el importador reporta la sintaxis que no proyecta al modelo A3, los recursos candidatos sin resolver y los conflictos de identidad.

La vista previa crea un mapa persistente clave de origen → UUID. Las actualizaciones requieren ese mapa, comprueban las identidades existentes y presentan un diff antes de aplicar. La aplicación es un único comando reversible que vuelve a comprobar revisión y hash del Resource. La autoridad es elegida en una acción explícita. IDs que solo difieren por capitalización son conflicto. Las entradas que desaparecen en una actualización no se eliminan automáticamente.

## Alternativas descartadas

- Importar cada sintaxis que Mermaid puede renderizar: renderizar no demuestra semántica A3 equivalente y ocultaría pérdidas.
- Regenerar el Mermaid desde los modelos A3: se perderían comentarios, directivas, estilos, layout y sintaxis aún no admitida.
- Inferir relaciones de campo FK en ER: la fuente no entrega un destino de campo comprobable.
- Reutilizar automáticamente IDs por título: títulos editables y no únicos no proporcionan identidad confiable.

## Consecuencias

Las vistas parciales siguen siendo útiles y auditables, pero pueden requerir editar el modelo manualmente. La fuente sigue siendo la copia íntegra para todo lo que no se convierte. El store actualmente limita la operación importada al archivo Mermaid interno del proyecto; importación de montajes y URLs requiere una política de lectura de recursos específica y no se habilita por inferencia.
