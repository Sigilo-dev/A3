# ADR 0012: enlaces derivados y acciones según contexto

Fecha: 2026-10-16. Detalle compatible de E2-F2; no cambia los schemas E0 ni el formato 1.0.0.

## Decisión

El host construye un índice regenerable a partir de Entity/Resource Markdown autorizados. Contiene IDs, títulos, rutas, revisiones, destinos, offsets y diagnósticos; no se serializa otra fuente documental ni se crean Relations/VisualEdges. Se reconstruye al consultar, reabrir, guardar, activar página, recuperar foco de ventana o pulsar Actualizar índice. El índice no concede acceso a un montaje ni inicia red. El límite inicial de fuente indexable es 2 MiB UTF-8 por página. Los recursos ocultos/ignorados o no disponibles se diagnostican; sus bytes no se sustituyen.

`[[Página|Alias]]`, `[[Página#Encabezado]]`, `[[Página^bloque]]` (fixture E0), `[[Página#^bloque]]` y `[[UUID|Alias]]` usan la misma resolución. El selector de creación copia un vínculo por UUID, que sigue siendo Markdown legible. El alias es texto de presentación, no un segundo identificador global. Un título/nombre de archivo ambiguo devuelve todos los candidatos y exige selección. Un fragmento inexistente o repetido se diagnostica sin escoger por posición. Los encabezados ATX tienen slug Unicode y desambiguación numérica; los bloques tienen `^id` explícito. Los saltos a fragmentos muestran la fuente y su cursor; no buscan por coincidencia aproximada en el DOM visual. Un borrador pendiente no recibe offsets de otra revisión.

Los enlaces Markdown locales inline y de referencia resuelven rutas relativas y fragmentos a páginas registradas. Se excluyen imágenes, código, frontmatter, comentarios y bloques HTML ejecutables. No se promete un parser universal de todas las extensiones Markdown. Las rutas de montajes se distinguen en el índice mediante `@mount/<mountId>/...`, sin publicar raíces absolutas ni bindings.

Renombrar título o mover archivo conserva los IDs y usa el writer/journal existente para el conjunto: metadatos, fuente movida y referencias conocidas que se resuelven sin ambigüedad. Se editan spans concretos, conservando alias, resto de fuente, BOM UTF-8 y finales de línea. Se recalculan las rutas relativas cuando cambia origen o destino; un nombre que pasa a ser ambiguo usa UUID. La misma ampliación de referencias se aplica a los comandos genéricos de dominio y al explorador, sin alterar el plan puro sellado del dominio. El host vuelve a comprobar capacidades para todos los archivos del plan, además de su read set, hashes y revisiones. La operación de varios archivos continúa siendo **lógica y recuperable, no atómica**.

Si no se puede indexar una fuente necesaria, preservar su codificación, actualizar una referencia de solo lectura o validar el conjunto, no se prepara una escritura parcial. Las referencias ambiguas/no resueltas no se reescriben por conjetura. La relocalización de una fuente ausente de E2-F1 sigue siendo reparación explícita de descriptor, sin mover/reemplazar bytes.

## Interfaz y permisos

Focus conserva un historial acotado de visitas por sesión. Atrás/adelante activa una vista existente o reabre su ID si fue cerrada; no crea otra copia de la página. Orden/selección/vistas siguen en la sesión local E2-F1; el recorrido de visitas no se restaura entre procesos ni se comparte con otro proyecto.

Los menús de página, canvas, placement, grupo, trazo, archivo y carpeta registran únicamente acciones implementadas. Las concesiones se consultan al abrir el menú, y se validan de nuevo al ejecutar en el host. Una acción denegada conserva foco y muestra capacidad/motivo. Los menús se abren con clic derecho, tecla de menú o Shift+F10; flechas/Home/End recorren opciones, Escape/Tab cierran y restituyen foco. El editor mantiene su menú de edición nativo. Los montajes permanecen de solo lectura bajo E0-C2; no aparece un comando de escritura externa privilegiado.

Atajos: registro puro de acciones/contextos, validación de formato y colisiones, teclas reservadas del editor/sistema, coincidencia exacta de modificadores e IME. Las personalizaciones viven en `userData/local-projects/shortcuts.json`, bajo propietario del catálogo local, fuera del proyecto y de Git. Un archivo inválido se conserva; Restaurar predeterminados es una acción explícita. Cambiar atajos no concede permisos. El foco de input/editor evita operaciones de canvas. Ctrl+F, selección, copiar/pegar, undo/redo de texto y Space+arrastrar conservan los mecanismos existentes.

No se agregan dependencias. A3-010 y partes de A3-044/A3-052; no cubre la totalidad de preferencias, plugins, temas, exportaciones o accesibilidad.
