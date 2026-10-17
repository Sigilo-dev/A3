# E3-F2 · exportación de lienzo

El exportador recibe snapshots de `LocalCanvasWorkspace` ya autorizados por el host. No lee el estado de React Flow, no captura paneles y no importa el renderer de la interfaz. El mismo SVG generado por `@a3/project-store` alimenta el archivo SVG, la rasterización PNG de Chromium y las páginas PDF.

## Comportamiento

- Alcances: selección de placements/grupos/trazos/líneas, grupo, diagrama actual y todos los workspaces del proyecto. Al exportar una selección se incluyen líneas visuales internas; conexiones que salen de ella quedan fuera y se diagnostican. Una línea seleccionada incluye sus extremos.
- SVG exporta geometría, texto, grupos, trazos y relaciones semánticas conocidas. Los trazos vectoriales usan los puntos/presión guardados con las versiones fijadas de Perfect Freehand 1.2.3 y Rough.js 4.6.6. Las imágenes raster locales pueden incrustarse; el `<metadata id="a3-export-report">` enumera rasterización y diagnósticos. Enlaces externos solo aceptan `http:`/`https:`. Referencias locales se conservan como `a3-resource:<id>` y necesitan el proyecto A3 para resolverse.
- Video, audio y YouTube se representan con una tarjeta poster/enlace; el exportador no descarga miniaturas ni inicia reproducción. HTML, scripts, motores de diagramas y plugins no se ejecutan. Un tipo de extensión sin renderer deja fallback/diagnóstico.
- Fondo transparente, opaco o del perfil, margen y escala son configurables. PDF admite papel A3/A4, orientación, margen, ajustar a una página y mosaicos multipágina. Los mosaicos recortan el mismo SVG; el máximo es 100 páginas.
- El host abre un selector nativo para el destino. PNG se captura en un `BrowserWindow` oculto y aislado, sin preload ni Node. PDF se imprime desde una página local temporal con CSP sin scripts y únicamente imágenes `data:`. Los temporales se limpian al completar o cancelar.
- `Proponer` pide aprobación local para `export`; `Trabajar` lo permite; `Consultar` lo deniega. El broker autoriza antes de leer el snapshot y el selector nativo controla la ruta elegida.

## Límites verificados

El fixture automatizado comprueba dimensiones SVG deterministas, transparencia/fondo opaco, XML escapado, poster de imagen raster, enlaces y selección/grupo. También comprueba el plan de dimensiones y el HTML de página multipágina A3/A4; la escritura PDF de Electron aún requiere una prueba de integración del host. El plan limita cada exportación a 15 000 primitivas, PNG a 30 megapíxeles, a 100 workspaces y PDF a 100 páginas. Reduce alcance/escala para evitar uso excesivo de memoria.

Mermaid, PlantUML y Structurizr se conservan como fuente/tarjeta diagnóstica en este exportador nativo; no se invocan sus motores durante exportación, por lo que su apariencia visual no se reproduce aquí. La prueba fija medidas y geometría, no compara una referencia visual aprobada. **A3-017 queda parcialmente verificado; A3-016 no queda cerrado.** No se garantiza identidad entre sistemas operativos, fuentes instaladas o versiones de Chromium/Electron.
