# ADR 0010: edición de código, representación de bytes y acceso por identidad

Estado: aceptada para E2-E1. Detalle compatible con E0-A, E0-C2, E0-D1 y los servicios E1; no modifica esquemas ni habilita capacidades externas nuevas. Trazabilidad: especificación §§9, 12.3, 18, 21; A3-011.

## Decisión

El editor CodeMirror 6 se carga bajo demanda desde el explorador o un nodo `a3.content.code`. El renderer recibe un documento con token de sesión, resource ID opcional, revisión, hash y representación del texto. Envía únicamente identidad, revisión/hash observados y buffer al host. Las rutas mostradas no son identificadores ni argumentos de acceso por IPC. Los módulos de lenguaje están incluidos y fijados; los proyectos no pueden aportar extensiones ejecutables.

Abrir un archivo sin descriptor no crea metadatos. Si se modifica por primera vez, el host prepara una operación `write-file` del escritor existente que registra un Resource y reemplaza su contenido mediante el mismo journal. Los siguientes guardados usan `prepareResourceWrite`. El registro y los bytes son una operación lógica recuperable de varios archivos, no una escritura atómica conjunta. Se conservan las validaciones de raíz, identidad, revisión, hash, exclusiones, permisos efectivos y recuperación E1.

Se admiten UTF-8 estricto sin/con BOM y UTF-16 LE/BE con BOM únicamente cuando la decodificación y recodificación reproducen todos los bytes. No se adivinan codificaciones heredadas. Binarios reconocidos o con controles y codificaciones inválidas no se interpretan como texto. Finales de línea mezclados o CR aislado son solo lectura. LF/CRLF uniformes se reconstruyen explícitamente al obtener el buffer de CodeMirror; `doc.toString()` por sí solo devuelve LF. Un guardado sin cambios no reescribe ni registra archivos, y no aumenta la revisión.

Metadatos A3 y fuentes canónicas de dibujo no se editan con el editor genérico. Las fuentes ocultas/ignoradas no pueden abrirse mediante un resource ID para eludir el explorador. Los montajes conservan la restricción E0-C2 de lectura externa: una concesión que solicite escritura no habilita una capacidad no demostrada. Rechazos y archivos ausentes conservan referencias y bytes.

Un conflicto mantiene el borrador y muestra la versión guardada para comparar. La persona elige usar esa versión o guardar su borrador sobre la revisión comparada; el host comprueba de nuevo las precondiciones. Un conflicto externo pendiente del store sigue bloqueando escritura hasta resolver/reabrir. Al guardar se invalidan las vistas previas visibles y los IDs efímeros del listado se actualizan; no se crea una copia canónica en React.

El cierre de la aplicación consulta las guardas del renderer antes de liberar el escritor. Cancelar deja disponible la sesión para guardar; descartar permite cerrar. Los buffers no confirmados viven en memoria; el journal protege transacciones iniciadas, no cada pulsación ante muerte del proceso.

## Consecuencias

Se limita el editor a 2 MiB por archivo en este bloque y a un archivo completo por diálogo. Los rangos de nodos, ejecución, terminal, compilación, depuración, autodetección de codificaciones heredadas y edición externa quedan fuera de E2-E1. TOML usa el modo oficial de `legacy-modes`; no promete el mismo plegado semántico que los parsers modernos. El resaltado y la recuperación del parser permiten editar código incompleto; no certifican que compile.

Versiones, matriz de compatibilidad y comprobaciones: [editor de código E2-E1](../e2/code-editor.md).
