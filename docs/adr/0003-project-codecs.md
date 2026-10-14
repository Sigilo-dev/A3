# ADR 0003 — Codecs y lectura de proyecto E1-C1

Estado: implementado. Fecha: 2026-10-14. Base: E1-B `c141918` en `codex/e1-base`. Detalles compatibles con §§6–8/28, contratos E0-A y ADR 0002; no cambia el formato 1.0.0 ni los esquemas E0/E1.

## Autoridad y separación

`@a3/project-store` es un paquete de host Node separado del dominio puro y del renderer. El codec produce bytes en memoria; el lector solo abre archivos para lectura. No expone escritura, permisos, commit, watcher, lock, journal, recovery o migración. No se conecta todavía al IPC del desktop. Una lectura válida no equivale a autorización ni a una base reservada para guardar.

Se reutilizan `validateRecord` y `validateSnapshot` de `@a3/domain`, con los esquemas estáticos E0/E1 y Ajv ya fijado. La única ampliación de su diagnóstico es `instancePath` opcional para localizar errores de esquema sin interpretar mensajes de Ajv. No se descarga ni compila un esquema de usuario. Las vistas mantienen `workspaceId` en el wrapper, fuera del JSON canónico; no se serializa React Flow.

## Bytes y orden canónico

Para documentos nuevos o modificados se elige orden lexicográfico de claves por unidades UTF-16 en todos los objetos, incluyendo claves desconocidas y claves numéricas aparentes. Se imprime directamente ese orden, sin reconstruir un objeto cuya enumeración reordenaría claves numéricas. Los arrays conservan su orden. La salida es UTF-8 sin BOM, indentación de dos espacios y un LF final. No es JSON Canonicalization Scheme ni una firma criptográfica estandarizada.

Un no-op devuelve exactamente los bytes originales: orden, espacios, escapes, BOM UTF-8 y CRLF incluidos. No se canonicaliza al abrir. El árbol completo leído conserva campos desconocidos en cualquier nivel y namespaces como datos inertes. `encodeDocument` aplica únicamente edits explícitos por JSON Pointer sobre una copia de ese árbol; un campo no mencionado no desaparece. Un edit explícito puede modificar/quitar datos opacos: no se considera pérdida automática. No se acepta reemplazar la raíz ni recorrer propiedades heredadas. Para añadir elementos se reemplaza explícitamente el array; no se implementa RFC 6902 completo.

Las identidades y el ámbito del documento no cambian al codificar. Un cambio real exige exactamente la revisión anterior + 1; el codec no inventa una revisión ni confirma que se haya guardado. Un no-op conserva la revisión, también al llegar a MAX_SAFE_INTEGER. La API para un registro nuevo valida su shape/revisión pero el futuro servicio debe verificar ausencia, revisiones esperadas y autorización de creación. La validación semántica del conjunto resultante también pertenece al servicio antes de escribir.

Markdown, código y binarios son Resource, no documentos JSON de dominio. Su lectura entrega bytes y SHA-256, sin decodificar ni modificar encoding, BOM o fin de línea. El hash observa bytes y no otorga acceso. El codec JSON tampoco altera el descriptor Resource por abrir su contenido.

## Errores y versiones

El parser aplica gramática JSON estricta, UTF-8 válido y posiciones de origen. Sintaxis inválida conserva los bytes y no entrega un objeto sustituto. Un error de esquema conserva el árbol para inspección, pero no entrega un registro tipado elegible para codificación. Los diagnósticos separan `syntax`, `schema`, `references`, `compatibility` e `io`; incluyen ruta y, cuando existe token, JSON Pointer, línea/columna y offset de bytes. Línea/columna son de base 1, la columna cuenta unidades UTF-16 y el offset de bytes es de base 0. Para UTF-8 inválido se informa el byte afectado.

Claves repetidas, incluso aliases con escapes, son ambiguas. Un número cuyo valor decimal no sobreviva a `Number` y su impresión, overflow/underflow o `-0` podría perder datos al reescribir. En estos casos se retienen los bytes y se permite inspección, sin elegir un valor duplicado ni exponer números aproximados como dominio. No se añade una dependencia/parser de terceros ni un tipo BigInt al contrato JSON. Una representación futura con tokens numéricos podría ampliar esa edición sin alterar el resto del modelo.

Solo `formatVersion`/`schemaVersion` exactamente `1.0.0` admite el codec actual. Un major superior queda en solo lectura, y cualquier minor/patch/prerelease/build desconocido también, hasta una compatibilidad explícita. Se inspecciona la versión antes de aplicar el esquema de esa versión. No se cambia la versión para hacerla pasar. Un manifiesto no soportado se inspecciona sin recorrer un layout supuesto; documentos futuros dentro de un proyecto 1.0.0 se conservan y los vecinos sanos se leen. Un Drawing solo tiene encabezado E1-B conocido: se inspecciona, pero su geometría no se reescribe.

## Lectura local y límites

El catálogo se resuelve desde `catalogRoot` validado y nombres UUID. Se leen categorías E0 y los documentos Group/Collection/VariableSet ratificados por E1-B; se comprueban filename/ID y alcance de variables. Las rutas conservan `/` portable. El host rechaza traversal, unidades, barras invertidas y aliases de Windows (nombres reservados, puntos/espacios finales y caracteres no admitidos). Antes/después de una lectura verifica componentes con `lstat`, tipo regular, `realpath` y contención; no sigue symlinks/junctions, incluso si apuntan dentro del proyecto. La raíz elegida por el host se resuelve a su ruta real.

El lector no accede a montajes/URLs, no interpreta archivos locales de sesión/credenciales y no instala ni ejecuta paquetes. Mount/Policy/Git/locks de paquetes aún no tienen contrato de codec en este corte. Archivos de categorías desconocidas permanecen en disco sin normalización. Un manifiesto corrupto impide descubrir su catálogo con confianza; se conserva ese archivo y se informa apertura no disponible. Una entidad corrupta no impide inspeccionar las otras categorías.

Presupuestos por defecto, configurables por el host: 16 MiB por JSON, 128 MiB de bytes JSON totales y 10,000 documentos; profundidad JSON 128. El encoder comprueba la profundidad iterativamente antes de recursión y no emite documentos que su lector rechazaría por ese límite. Agotarlos produce diagnóstico y catálogo parcial/inspección, nunca éxito silencioso ni escrituras. Los recursos explícitos admiten por defecto 128 MiB por lectura, configurables; no hay streaming público en C1. Se leen chunks acotados incluso si un archivo crece entre `stat` y `read`. Cambios observables de tamaño/mtime durante la lectura se rechazan.

Estas guardas no confinan procesos arbitrarios ni cierran todas las carreras de sustitución de rutas. No hay snapshot coherente frente a otro escritor ni bloqueo de todos los archivos: hashes/revisiones requieren revalidación bajo el futuro writer. El broker E1-E debe resolver permisos y carreras con handles/garantías nativas antes de anunciar aislamiento. Journal, recuperación, restauración y migraciones siguen en E1-C2/D. No se afirma durabilidad ni transacción por leer/codificar.
