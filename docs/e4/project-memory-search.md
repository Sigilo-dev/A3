# E4-D1 · memoria explícita e índice aislado

Base aceptada E4-C2 `ba2ef1f`, A3 §17 y criterios A3-022/023, contratos Entity/Resource E0 y writer, permisos, rutas, Markdown/código y sesiones E1/E2. No se añaden dependencias, embeddings ni servicios de IA.

## Memoria portable y edición

En Memoria, «Crear documentos iniciales de memoria» crea `memory/overview.md`, `memory/decisions.md` y `memory/constraints.md` como páginas Markdown canónicas. La creación es explícita y requiere `document.edit`; abrir la pestaña no escribe archivos. Los proyectos existentes no reciben metadatos sin esta acción.

Cada página tiene Entity y Resource UUID revisados en el catálogo existente, etiqueta `memory` y `properties["a3.memory.role"]` (`overview`, `decisions`, `constraints` o `summary`). El rol permite reorganizar/mover una página mediante los comandos aceptados de E2 sin recrearla en su ruta inicial. El editor focus Markdown de E2 usa los mismos IDs, buffers, permisos, hashes/revisiones y diagnóstico de conflictos. Guardar sin cambios conserva sus bytes.

Si existe un Markdown no registrado en una ruta inicial, el writer lo adopta creando solo Entity/Resource; conserva bytes UTF-8, BOM y CRLF. Si el recurso ya existe, se reutiliza; repetir la inicialización no duplica los documentos. Una codificación o ruta no segura impide adoptarlo; el archivo no se sustituye por una plantilla. Un documento registrado ausente produce el diagnóstico del editor existente, sin fabricar texto vacío.

`prepareMemoryDocuments` reúne documentos y fuentes en un plan E1 bajo escritor único, revisiones/hashes, rutas seguras y concesiones verificadas de lectura/edición. Los archivos nuevos van por staging/journal; fuentes preexistentes se observan y no se sobrescriben. Se mantienen los límites de recuperación de E1: el lote de varios archivos es una operación lógica, sin prometer atomicidad conjunta o tolerancia a corte eléctrico real. Si una inicialización parcial encuentra recursos ya registrados, una nueva acción los reutiliza.

## Resúmenes con procedencia

Guardar un resumen es una acción explícita. Se introduce Markdown y se eligen fuentes documentales de este proyecto; el host comprueba lectura y registra los Resource IDs, ruta/etiqueta y SHA-256 del contenido observado, actor autenticado y fecha UTC. Se crea una página nueva en `memory/summaries/<uuid>.md`. La UI muestra las fuentes, hashes y fecha guardados en `properties["a3.memory.summary"]`; una procedencia ausente o inválida se diagnostica sin interpretar datos futuros como verificados.

No se llama a una IA para producir el resumen. Puede pegarse texto preparado externamente, que la persona revisa y registra. Editar después su Markdown conserva la procedencia de registro; esta indica qué fuentes se observaron entonces, no certifica exactitud ni se actualiza silenciosamente al cambiar las fuentes. No se importa el historial de chats automáticamente. Los documentos, conversaciones y resúmenes siguen siendo recursos distintos, sin convertir texto encontrado por búsqueda en memoria permanente.

## Índice local por sesión de proyecto

`LocalSearchIndex` vive en memoria del host, ligado al proyecto/sesión activos. Es derivado y descartable: no escribe la copia del texto en datos portables, no depende de SQLite/API y no hereda índices de otros proyectos. Cerrar/cambiar proyecto descarta el índice y sus exclusiones de sesión; volver a abrir permite reconstruirlo desde las fuentes. No se ofrece búsqueda en varios proyectos a la vez.

Cada consulta recorre el árbol autorizado con el explorador seguro E1, comprueba identidad/permisos y lee/hash-ea fuentes textuales acotadas mediante `readCodeFile` o el lector de Resource montado. Solo cambia las entradas derivadas cuyo contenido o metadatos difieren; desaparecidos, excluidos, binarios y lecturas ahora denegadas se retiran. La actualización es incremental en el índice; todavía relee las fuentes para verificar sus hashes, sin prometer indexación de disco completamente incremental o en segundo plano. «Reconstruir índice» descarta las entradas y vuelve a calcularlas con las mismas reglas/exclusiones, sin editar documentos.

Se indexa texto decodificable sin pérdida (UTF-8/BOM y UTF-16 con BOM por contrato E2), títulos y etiquetas de Entity, y la propiedad seleccionada `a3.content.description`. Código de archivos regulares internos se trata como texto, sin ejecutarlo. No se indexan todos los JSON administrados: el catálogo `.a3` y el manifiesto están excluidos; sus metadatos seleccionados se proyectan desde el snapshot validado. Una fuente compartida por varias entidades tiene una entrada con sus entidades y representaciones; archivos externos no referenciados nunca se descubren recorriendo todo el equipo.

Montajes: solo se contemplan Resource `mounted-file` registrados. Indexar requiere concesión efectiva `mount.index`, además de `mount.read` y la raíz local aprobada vigente para leer. `approval-required` se informa y no se transforma automáticamente en una concesión. No se exploran árboles externos enteros ni se siguen enlaces fuera de raíz. Revocar o perder la raíz retira las entradas en la siguiente consulta; un resultado previo que intente abrirse también pasa por los permisos del editor.

## Exclusiones, resultados y límites

Se aplican `.gitignore` del explorador y exclusiones obligatorias por segmento: `.git`, todo `.a3` (incluido `.a3/local`), `node_modules`, `venv/.venv/env`, cachés de Python/test/herramientas, `dist/build/out/target/coverage`, cachés comunes y `bin/obj`. Se omiten artefactos compilados/archivos y contenedores binarios conocidos, secretos por nombre (`.env*`, claves, credenciales) y cualquier archivo que falle la detección de texto. El usuario puede añadir patrones glob restringidos (`*`, `?`, `**`) por sesión; no conceden nuevas raíces ni levantan exclusiones de seguridad. Se conservan al volver a la pestaña y al reconstruir durante esa sesión.

Límites explícitos: 2 MiB por archivo, 32 MiB de lecturas textuales por consulta, 5000 entradas recorridas, 500 caracteres de consulta, 64 patrones y primeros 100 resultados. Los presupuestos omitidos se diagnostican y el resultado se marca parcial. El buscador compara términos literales sin distinguir mayúsculas ni acentos; todos deben coincidir, y prioriza título/etiquetas. No ejecuta regex del usuario ni implementa stemming/ranking semántico. Devuelve el total y un fragmento de hasta 300 caracteres con elipsis, sin truncar documentos originales.

Cada resultado muestra origen relativo, título, etiquetas, hash y fragmento; «Abrir fuente» usa CodeMirror E2 y «Mostrar en workspace» ofrece cada representación por ID. Las entidades sin recurso textual pueden encontrarse por metadatos y localizarse en el lienzo. No hay exportación automática ni carga remota. El índice no sustituye al índice de enlaces/backlinks de E2: comparten recursos, pero tienen funciones distintas.

## Evidencia A3-022/023

Fixture: `fixtures/e4/memory/scenario.json`. `packages/project-store/test/memory-search.test.mjs` usa directorios temporales para comprobar adopción de BOM/CRLF, edición, reutilización/movimiento de IDs, resúmenes con procedencia, búsqueda por título/etiquetas/texto/código, actualización tras edición/mudanza, igualdad tras rebuild, exclusiones/binaries/junctions, dos proyectos, sesiones caducadas, permisos/revocación y montaje desconectado. Las escrituras y lectura de Markdown/código conservan sus pruebas E1/E2.

`npm run test:memory --workspace @a3/desktop` prueba en Electron Windows la inicialización, apertura del editor focus por IDs, persistencia de edición mediante su puente, resumen explícito con fuentes/fecha, búsqueda/código, reconstrucción equivalente, entorno virtual excluido, IPC estricto y foco de teclado; renderer sin Node. No se declara ensayada una edición por teclado de Milkdown en este smoke: su editor ya tiene pruebas propias y aquí se verifica su apertura y servicio compartido. A3-022/023 reciben evidencia del alcance descrito, sin afirmar búsqueda semántica, indexación persistida en disco o escaneo recursivo de todos los montajes.

Comprobaciones de entrega: 22/22 pruebas dirigidas del store (`memory-search`, `navigation`, `security`), `npm run typecheck` de todos los workspaces y build desktop Windows. No se ejecutó la suite agregada completa ni se generó instalador. El build mantiene el aviso previo de chunks de diagramas mayores de 500 kB; no se introducen nuevas dependencias.
