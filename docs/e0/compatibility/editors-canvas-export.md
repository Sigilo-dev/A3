# Compatibilidad de editores, lienzo y exportación — E0-D1

Consulta y ejecución: 2026-10-14. Base: A3 1.0.0, §§4, 10, 12, 14, 26 y 30; contratos E0-A de dominio, comandos y extensiones. Checkout codex/e0-foundation, destino https://github.com/Sigilo-dev/A3.git. Entorno local: Windows 10 Pro 10.0.19045, Node.js 24.13.1, npm 11.10.0. El spike corre en Vite/React dentro del navegador local; no inicia Electron, no escribe archivos de proyecto y no sincroniza editores.

## Resultado observado

| Prueba | Resultado ejecutado | Qué demuestra |
|---|---|---|
| CodeMirror 6, guardar sin editar | **Pasa en este fixture:** la cadena obtenida de EditorView.state.doc coincidió exactamente con el Markdown UTF-8/LF cargado; siguieron presentes wikilink, fence de código y contenido desconocido. | Un editor de texto puede mantener esta fuente si no se modifica. No prueba una escritura a disco ni una edición posterior. |
| Milkdown/Crepe, guardar sin editar | **Falla el no-op:** getMarkdown() normalizó saltos y espacios y serializó [[entidad-a3|Entidad vinculada]] como \[\[entidad-a3|Entidad vinculada]]. El fence de código y el texto del bloque desconocido permanecieron visibles, pero el ::: ya no conserva semántica de bloque opaco. | No se puede usar su serialización como escritura automática de un archivo no editado. El renderer/serializer por defecto no satisface por sí solo la preservación requerida. |
| React Flow + Perfect Freehand | **Pasa el recorrido simple:** se seleccionaron/movieron dos nodos, se conectaron los extremos con una VisualEdge de prueba, se dibujó un trazo de 9 puntos y se guardó/reabrió un snapshot local. | El adapter del spike captura posiciones de nodos, arista visual, viewport y puntos del trazo en coordenadas de flujo. No prueba historial integrado ni persistencia de A3. |
| Zoom y geometría | **Pasa en el recorrido manual:** zoom 1.00 → 1.20 → 1.44; los puntos mundo no cambiaron. Después de reabrir el snapshot, los puntos eran iguales y el cálculo de posición informó 0.000 px de desplazamiento en pantalla. | screenToFlowPosition, flowToScreenPosition y un overlay dentro de ViewportPortal permiten un modelo de coordenadas compartido en este adaptador. No acredita todos los gestos, DPR, resize, pan o stylus. |
| SVG | **Pasa para la vista pequeña sintética:** contador del documento: 2 <text>, 2 <path>, 0 <image>, 0 <foreignObject>. | Etiquetas y geometría de nodos, arista y trazo salen como primitivas vectoriales. No se incluyeron medios ni fuentes incrustadas. |
| PNG | **Pasa para la misma vista:** image/png, 1920 × 1120 (vista base 960 × 560, escala 2). | El texto y todas las formas se rasterizan en el PNG. No se comprobó impresión, transparencia de medios ni fidelidad de color entre motores. |

El fixture Markdown contiene título con tilde, wikilink A3, bloque JavaScript y delimitadores :::bloque-desconocido con payload namespaced. El fixture de canvas empieza con dos nodos sin arista ni trazos. La arista conectada en la prueba es solo visual y no se transforma en Relation.

## Versiones y licencias revisadas

El 2026-10-14, npm view <paquete> version license consultó el registro npm. El package-lock.json del spike retiene las resoluciones exactas. Los ocho paquetes directos instalados declaran licencia MIT; npm run licenses vuelve a comprobar versión exacta y la declaración de licencia instalada. Esto no es una revisión legal exhaustiva de cada aviso transitivo ni de un instalador final de Electron.

| Paquete directo | Versión fijada | Declaración | Documentación / licencia |
|---|---:|---|---|
| @milkdown/crepe | 7.22.3 | MIT | [API de Crepe](https://milkdown.dev/docs/api/crepe), [licencia](https://github.com/Milkdown/milkdown/blob/main/LICENSE) |
| @codemirror/lang-markdown | 6.5.2 | MIT | [guía de CodeMirror](https://codemirror.net/docs/guide/), [licencia](https://github.com/codemirror/lang-markdown/blob/main/LICENSE) |
| codemirror | 6.0.2 | MIT | [modelo de documento plano y extensiones](https://codemirror.net/docs/guide/), [repositorio/licencia](https://github.com/codemirror/dev) |
| @xyflow/react | 12.12.0 | MIT | [ReactFlowInstance](https://reactflow.dev/api-reference/types/react-flow-instance), [ViewportPortal](https://reactflow.dev/api-reference/components/viewport-portal), [licencia](https://github.com/xyflow/xyflow/blob/main/LICENSE) |
| perfect-freehand | 1.2.3 | MIT | [API getStroke y renderizado](https://github.com/steveruizok/perfect-freehand), [licencia](https://github.com/steveruizok/perfect-freehand/blob/main/LICENSE) |
| react | 19.3.1 | MIT | [licencia](https://github.com/facebook/react/blob/main/LICENSE) |
| react-dom | 19.3.1 | MIT | [licencia](https://github.com/facebook/react/blob/main/LICENSE) |
| vite (desarrollo) | 8.3.4 | MIT | [guía](https://vite.dev/guide/), [licencia](https://github.com/vitejs/vite/blob/main/LICENSE) |

@xyflow/react es el paquete publicado para React Flow en esta versión. El lock es local a experiments/e0/editors-canvas/; no se cambió package.json raíz ni se añadieron paquetes productivos.

## Reproducir

Desde la raíz del repositorio:

    npm ci --prefix experiments/e0/editors-canvas
    npm test --prefix experiments/e0/editors-canvas
    npm run build --prefix experiments/e0/editors-canvas
    npm run dev --prefix experiments/e0/editors-canvas

Abre http://127.0.0.1:5173/. En ambos editores pulsa «Guardar sin cambio» antes de escribir. En el lienzo, mueve los dos nodos, conecta el puerto derecho de A con el izquierdo de B, activa «Dibujar» y traza en espacio vacío; pulsa zoom y «Comprobar coordenadas», luego «Guardar fixture» y «Reabrir fixture». «Crear SVG» y «Crear PNG ×2» generan Blob URLs y una previsualización en memoria. El arnés no descarga los Blob por sí solo. «Restablecer» borra solo la clave a3-e0-d1-canvas-fixture de localStorage de 127.0.0.1.

Las comprobaciones de exportación y licencias usan node:test; los gestos y el roundtrip de Milkdown/CodeMirror son interacción manual reproducible. El build se completó con 1267 módulos: JavaScript 1,764.86 kB (567.80 kB gzip) y CSS 100.66 kB (19.12 kB gzip). Vite advirtió que un chunk supera 500 kB y mostró advertencias del módulo “use client” de React Flow y flags de compilación de Vue dentro de la dependencia de Crepe. El bundle incluyó muchos modos de lenguaje y fuentes KaTeX; esto no es una medición de rendimiento de Electron y señala que la selección de features debe reducirse/partirse antes de integrar.

La instalación limpia con npm ci detectó **cuatro avisos low que corresponden a una vulnerabilidad transitiva**: KaTeX 0.18.1 cae en el rango vulnerable <0.18.2, dentro de micromark-extension-math/remark-math que llega por Crepe. [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7). npm audit ofreció una resolución que cambia de versión mayor el paquete Milkdown; no se aplicó downgrade ni override a KaTeX sin una prueba del soporte matemático. Aunque el fixture no contiene fórmulas, no debe promoverse este lock a producción antes de resolver y volver a probar ese árbol.

## Inferencia de compatibilidad, límites e integración pendiente

**Inferencia:** CodeMirror puede ser la vista fuente de un documento compartido; Milkdown puede ser una vista visual si A3 implementa su extensión de wikilinks y una representación/preservación explícita para bloques desconocidos. El spike muestra que no se debe persistir getMarkdown() automáticamente cuando el documento sigue sin cambios. Una estrategia de integración deberá conservar bytes originales hasta una edición efectiva y mostrar/retener los segmentos no soportados al editar. Para prevenir dos fuentes divergentes, fuente y visual deben operar sobre el mismo documento canónico con revisión/hash, actualización y conflicto según E0-A; este spike no implementa eso.

**Inferencia:** React Flow ofrece conversión de píxel a flujo y portales que comparten el transform de viewport; Perfect Freehand recibe puntos y genera un contorno que el caller decide renderizar. La compatibilidad observada requiere el adapter explícito de A3: persistir placements y edges del dominio y los puntos/params del dibujo, derivar elementos React Flow y poner el trazo dentro del mismo espacio de flujo. El estado nativo completo de React Flow no pasa a ser formato A3.

Las APIs de edición, selección del lienzo y trazo no comparten selección, pila undo/redo ni transacciones por aparecer en una misma aplicación. No se probó undo en ninguno, historial conjunto, selección de dibujo, agrupación ni sincronización de texto con vista. Deben resolverse mediante un comando/documento compartido y un contrato de historial de A3, no por acoplamiento supuesto entre paquetes.

El SVG de prueba contiene texto SVG y paths vectoriales. La forma permanece vectorial al escalar; la apariencia del texto depende de disponer de Arial/sustituto porque no se incrustó una fuente. El PNG creado a partir de SVG es una sola imagen rasterizada. El exportador es un helper específico del fixture; no exporta selección/grupo/workspace completos, assets, transparencias requeridas ni PDF.

No se midieron FPS, memoria, documento de 100 páginas, canvas grande, electron renderer o paquete distribuido. La advertencia de bundle amerita configurar importaciones/features de Milkdown, carga diferida de editores y medición real en el objetivo Windows antes de fijar la arquitectura productiva.

## Trazabilidad de aceptación

| Criterio | Evidencia y estado |
|---|---|
| A3-006 lienzo | Dos nodos se seleccionaron/movieron y se conectó una arista en React Flow. **Parcial**: no se probaron alineación, grupos, contracción, redimensionado, persistencia de proyecto ni undo/redo. |
| A3-007 dibujo | Zoom no alteró los puntos de flujo; guardado y reapertura del snapshot mantuvieron la geometría. **Parcial**: presión real, stylus, pan, DPI/resizing, historial y project-store no probados. |
| A3-008 pegado inteligente | Sin prueba en este spike. |
| A3-009 página focus | CodeMirror devolvió bytes idénticos; Milkdown alteró wikilink y estructura del bloque desconocido al serializar sin cambio. **No pasa el requisito de conservación general.** Navegación entre páginas y edición simultánea no probadas. |
| A3-016 estilos originales | Sin referencia aprobada de motor/tema/fuente ni comparación visual. Sin prueba. |
| A3-017 SVG/PNG/PDF | SVG y PNG de una vista sintética pequeña comprobados. **Parcial**: selección, grupo, workspace, transparencias, medios/posters, PDF y comparación de contenido completa no probados. |
| A3-052 accesibilidad | No se ejecutaron pasos de teclado ni auditoría de foco/nombres/escala de página y propiedades. Sin prueba. |

Ninguno de estos criterios se declara completo. La evidencia es un spike de dependencias y adaptación, no una aplicación A3.
