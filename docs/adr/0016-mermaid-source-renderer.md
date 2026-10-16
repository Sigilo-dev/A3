# ADR 0016: renderer Mermaid de solo fuente

Fecha: 2026-10-16. Alcance: E3-D1, especificación §§14.1–14.4 y evidencia E0-D2.

## Decisión

Se fija Mermaid `12.2.0` (MIT) para render local de `a3.diagram.mermaid@1.0.0`. DOMPurify `3.4.17` (MPL-2.0 OR Apache-2.0) se fija como dependencia directa para sanear el SVG antes de insertarlo en el DOM. La versión del renderer queda guardada en la entidad y cualquier perfil distinto cae a fuente/fallback.

La entidad marca `a3.diagram.authority = "source"`. El archivo Mermaid completo es un Resource canónico; render y diagnóstico son derivados transitorios. El renderer no crea un modelo A3, no reescribe la fuente, no ejecuta HTML/scripts/plugins/click handlers y no llama `bindFunctions`. La conversión posterior permanece en un adaptador separado con gramática y fixtures propios: [ADR 0017](0017-mermaid-import-subset.md).

La ejecución se limita a un nodo visible, `securityLevel: strict`, HTML labels apagadas, tema default, 128.000 caracteres y 500 aristas. Mermaid C4 se considera experimental como en E0-D2. Los bytes excedentes o fuentes de sintaxis inválida quedan intactos y visibles desde la fuente conservada.

## Motivo

E0-D2 renderizó fixtures Mermaid C4 y class con Mermaid 12.2.0, mientras que `@mermaid-js/parser` 2.0.1 no reconoció esos tipos. Por ello el renderizador puede mostrar una fuente, pero no prueba que exista una representación A3 equivalente. Mantener `source` como autoridad evita una pérdida por conversión implícita.

## Consecuencias

Se añade un renderer dinámico y un sanitizador directo. La app ofrece una vista segura dentro del nodo, diagnóstico con ubicación cuando está disponible y acceso a la fuente completa. Este ADR no ofrece importador general, perfiles personalizados ni export SVG/PNG/PDF de selección/workspace. La conversión parcial del subconjunto flowchart/class/ER queda definida por separado en ADR 0017. La licencia MIT de Mermaid no se atribuye a DOMPurify ni a todo el bundle; las licencias están separadas en el lock.
