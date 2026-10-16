# E2-D2: modo fuente y preservación Markdown

E2-D2 añade CodeMirror 6 para editar la fuente del mismo recurso Markdown que Milkdown. `entityId`, `resourceId`, hash y revisión permanecen compartidos; cambiar de modo conserva el buffer en memoria y no crea una segunda copia ni ejecuta Markdown o HTML.

## Modo y preservación

CodeMirror abre el texto UTF-8 completo con resaltado Markdown, números de línea, búsqueda y edición de fuente; su módulo se carga bajo demanda al entrar a Fuente. Conserva el separador uniforme LF o CRLF observado al abrir. Abrir y guardar sin cambios no envía una escritura: el store comprueba los bytes y el hash actuales, por lo que BOM, finales de línea y espacios originales quedan intactos.

Milkdown solo se habilita para la sintaxis que su editor puede representar sin pérdida conocida. Frontmatter, directivas `:::`, callouts, wikilinks incrustados, footnotes, matemática, HTML crudo, protocolos ejecutables e IDs de bloque A3/Obsidian quedan en modo fuente. Los bloques opacos, wikilinks, anchors e IDs de bloque se conservan como texto fuente; el editor no trata un renderer desconocido como estructura editable.

CodeMirror informa errores del parser Markdown y wikilinks A3 incompletos con línea y columna. Mientras exista un error localizado, el guardado se detiene y el archivo persistido conserva sus bytes; el usuario puede corregir el buffer fuente y volver a guardar. La sintaxis desconocida no se interpreta como error si el parser la admite como texto literal.

## Revisión y conflictos

Cada guardado pasa por el escritor del host con revisión y SHA-256 observados. Un cambio de archivo o de entidad rechaza la escritura y conserva el borrador. La resolución muestra el texto guardado y el borrador lado a lado; el usuario puede usar la versión guardada o volver a guardar explícitamente su borrador sobre la revisión comparada. El host vuelve a comprobar hashes, revisión, permisos y estado externo. No se realiza una fusión automática.

La edición fuente sigue dependiendo de los permisos efectivos locales del proyecto. Los recursos montados o de solo lectura, sesiones inactivas y proyectos con conflicto externo no aceptan escrituras.

## Alcance y compatibilidad

CodeMirror, `@codemirror/lang-markdown`, `@codemirror/language` y `@codemirror/state` se fijan con versiones MIT exactas del spike E0-D1. La edición visual no ofrece round-trip universal para sintaxis que Milkdown no representa; esa sintaxis se edita en fuente. CodeMirror normaliza a un separador uniforme cuando se modifica un documento con finales mezclados; abrir/cerrar sin edición conserva los bytes originales.

Validación dirigida: fixture Markdown E0-D1 en LF, fuente de prueba con BOM y CRLF, edición de texto común conservando wikilink/código/bloque `:::`/block ID, error A3 wikilink con ubicación y rechazo de guardado, no-op de bytes, conflicto de revisión con comparación y resolución. Trazabilidad: A3-009–010 y A3-047–048.
