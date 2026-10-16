# E2-D1: editor visual Markdown

El editor visual se abre desde los nodos de página y texto breve. El lienzo y el editor comparten el `entityId`, el `resourceId` y las revisiones del mismo documento. El Markdown guardado sigue siendo el contenido canónico; Milkdown solo es una vista editable. Cambiar de sección o workspace no crea copias persistentes.

## Formatos cubiertos

El preset CommonMark cubre párrafos, encabezados, listas, citas, enlaces, imágenes y bloques de código. El preset GFM añade tablas y checkboxes. La extensión A3 conserva wikilinks `[[página]]`, alias `[[página|texto]]` y fragmentos de encabezado o bloque en su sintaxis Markdown legible. El checkbox modifica el mismo nodo de lista y el mismo recurso Markdown.

Las imágenes relativas se resuelven desde el archivo Markdown contra un `Resource` interno registrado en el proyecto. El host valida la ruta portable, comprueba permiso de lectura y solo entrega imágenes raster locales PNG, JPEG, GIF, WebP, AVIF o BMP de hasta 4 MiB cada una; la sesión limita las vistas previas a 64 imágenes y 16 MiB. SVG, recursos sin descriptor, URLs remotas, referencias absolutas y rutas que salen del proyecto quedan sin cargar. El preview usa URLs `blob:` efímeras y las revoca al cerrar el editor. Los links Markdown no navegan desde esta vista.

## Preservación y seguridad

Un no-op no guarda ni serializa Milkdown: el host compara bytes, hash y revisión y devuelve el original sin incrementar revisión. La lectura UTF-8 es estricta y conserva BOM. Un guardado modificado utiliza el escritor transaccional existente con hash y revisión esperados; el escritor valida el proyecto, las capacidades y los cambios externos. Una revisión obsoleta presenta conflicto y deja el borrador abierto.

Los documentos con HTML crudo, directivas `:::`, frontmatter, callouts Obsidian, wikilinks incrustados, footnotes, bloques matemáticos o protocolos ejecutables permanecen en modo fuente y no admiten escritura visual. Desde E2-D2, CodeMirror edita esa fuente sin reserializarla por Milkdown. La entrada HTML nunca se inyecta como DOM. El renderer no ejecuta plugins binarios de Obsidian. Una fuente UTF-8 inválida, un recurso externo o un proyecto sin permiso de escritura permanecen en modo de solo lectura con diagnóstico.

La carga de recursos se hace mediante el bridge IPC verificado, y no por una ruta o filesystem del renderer. La CSP de escritorio bloquea contenido de red, objetos, formularios y frames. La vista no abre enlaces ni crea reproductores.

## Dependencias y límites

Se fijaron `@milkdown/core`, `@milkdown/plugin-listener`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm` y `@milkdown/utils` en `7.22.3`; sus metadatos de paquete declaran MIT. Se carga el editor bajo demanda y se omite Crepe y sus funciones de matemática, que en el spike E0-D1 traían KaTeX vulnerable. Las funciones Markdown compatibles no requieren ejecución de extensiones externas. El lockfile es la lista reproducible de transitivas.

Esta etapa no incluye extensiones binarias, compatibilidad completa con el ecosistema Obsidian, resolución de nombres wikilink contra el índice, conversión de enlaces al renombrar páginas, Mermaid/math, descarga de imágenes remotas ni edición Markdown de montajes externos. Las extensiones desconocidas no se descartan: bloquean la escritura visual para ese documento y permanecen disponibles en fuente. El modo CodeMirror, su diagnóstico de sintaxis y la resolución comparada de conflictos están documentados en [E2-D2](markdown-source.md).

Verificación E2-D1: pruebas de dominio cubren wikilinks y fixtures E0-D1; pruebas del store cubren BOM/CRLF no-op, edición, recurso imagen portable, rutas escapadas, conflicto de revisión y denegación del perfil Consultar; el smoke de Electron cubre editor visual, vista previa, checkbox y recurso local. Véase [E0-D1](../e0/compatibility/editors-canvas-export.md) y [A3-009](../../A3_ESPECIFICACION_MAESTRA.md#12-markdown-documentación-y-edición-de-código).
