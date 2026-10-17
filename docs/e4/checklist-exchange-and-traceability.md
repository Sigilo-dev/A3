# E4-E1 · intercambio de checklists y trazabilidad

Base aceptada: E4-D1 `d6e87d5`, E4-C1/C2, contratos E0-A Entity/Resource/Placement y comandos con revisión, writer/journal/broker E1. Aplica A3 §15–17 y A3-018–023, especialmente A3-021. No cambia schemas del proyecto ni añade dependencias.

## Markdown de intercambio 1.0.0

El fixture `fixtures/e4/planning/checklist.md` muestra el formato completo. Tiene una cabecera `a3-checklist` con versión y `projectId`; cada línea `- [ ] título` o `- [x] título` lleva inmediatamente después un comentario JSON `a3-task` con `id`, `revision`, título original, `data` de TaskData y `contentResourceId` opcional. Los IDs de historia, criterios, dependencias, evidencias y referencias son los canónicos, nunca nombres o rutas usadas como identidad.

Es una exportación canónica de tareas elegidas, ordenadas por ID. Los comentarios mantienen referencias y propiedades futuras legibles en el fuente Markdown; los caracteres de cierre de comentario se escapan como JSON. No se evalúan Markdown/HTML, JavaScript ni instrucciones de los textos. Se escapan títulos para conservar Unicode, metacaracteres y saltos de línea. Se admiten LF, CRLF y BOM UTF-8 al analizar. El lector de archivo de la interfaz rechaza UTF-8 inválido, sin tocar el original.

`done` se exporta marcado. Una casilla marcada propone `done`; desmarcar un `done` propone `todo`. Una casilla desmarcada cuyo metadata dice `in_progress`, `blocked` o `cancelled` conserva ese estado. Para cambiar entre esos estados, se modifica `data.state` y se revisa el preview. El título de la línea es el título entrante. Modificar el metadata permite revisar los demás campos del contrato de tarea. No se aceptan documentos Markdown arbitrarios sin IDs/metadata ni correspondencia aproximada por título.

La selección es explícita y no amplía contexto por cercanía, líneas visuales, memoria o carpetas. Los tokens de variables y bindings permanecen en su fuente canónica: este formato de intercambio no elige un workspace ni sustituye valores efectivos. La compilación de prompts con resolución y contexto elegido continúa en E4-A/B. Exportar tareas no copia documentos, archivos de evidencia, historial de chats ni credenciales. No exporta una historia completa: sus referencias requieren que la historia/criterios/evidencias ya existan en el proyecto destino.

Máximo por lote: 128 tareas y 256 KiB UTF-8, metadata incluida. Si no cabe se rechaza y solicita dividir, sin recortar. «Seleccionar primeras 128» es una acción explícita, y cada casilla permite ajustar la selección.

## Preview, matching y aplicación

1. Pegar Markdown o cargar un `.md` solo crea un buffer de sesión. Previsualizar analiza cabecera, sintaxis, IDs, referencias y grafo propuesto sin escribir.
2. Matching exclusivamente por UUID: tarea existente, alta con ID nuevo, sin cambios, cambio, conflicto de revisión o ID ocupado por otro tipo/no editable. Un proyecto distinto, ID repetido, versión no admitida, ciclo o referencia rota impide aplicar; la fuente queda disponible para corregirla o retirar la fila y volver a previsualizar. No se crean recursos vacíos para corregir referencias.
3. El panel muestra datos actuales/entrantes, revisiones y campos afectados. Cada fila exige una decisión `keep` o `import`; por defecto se conserva lo existente. Conflictos y altas comienzan sin decisión. No se fusionan campos automáticamente ni se adivinan IDs alternativos. Elegir importar sobre un conflicto sustituye los campos revisados usando la revisión **actual del preview**, con autorización del usuario.
4. El host conserva un token acotado a sesión y fingerprint del snapshot, y muestra SHA-256 del fuente. Cambiar proyecto/cerrar invalida tokens. Si el proyecto cambia después del preview, aplicar devuelve `REVISION_CONFLICT`; hay que comparar de nuevo. El token se consume al completar y no se puede reproducir. Eliminar texto del Markdown no elimina tareas.
5. Se valida otra vez la selección resultante: excluir una alta requerida por otra fila no crea referencias huérfanas. Las operaciones aceptadas usan `a3.planning.change`, validación de E4-C1, política de evidencia, actor/fecha del host y writer transaccional. El archivo no atribuye el cambio a otra persona ni concede permisos. Un alta empieza con revisión 1 e historial local nuevo; no importa historial ficticio. Una operación sin cambios no reescribe documentos ni agrega actividad.

El broker exige `project.read` para consultar/previsualizar, `export` para generar/guardar el intercambio y `task.edit` al aplicar; comprueba la revocación incluso en una aplicación sin cambios. Mantiene el bloqueo de solo lectura, conflictos externos y evidencia obligatoria del servicio existente. Las operaciones de varios documentos conservan las garantías del journal E1: unidad lógica recuperable, no atomicidad conjunta de archivos ni evidencia de corte eléctrico real.

## Interfaz y archivo exportado

Tareas incorpora selección, exportación al buffer, copia de la selección canónica mediante el portapapeles del host, carga de archivo, preview y decisiones por fila. Copiar comprueba otra vez `export`; el buffer también permite seleccionar/copiar texto manualmente. Guardar la selección usa un diálogo nativo del host: no depende de descargas de Chromium, bloqueadas por el shell. Vuelve a verificar permiso/sesión y hash de selección tras el diálogo. Cancelar no escribe. El destino es un archivo `.md` **nuevo**; si existe, se devuelve `EEXIST` y se conserva. Se prepara un temporal exclusivo junto al destino, sincroniza el archivo y publica mediante hard link sin reemplazo en el volumen Windows probado. Una ruta no local, junction/symlink o volumen que no admita la operación genera error; no se aplica un fallback que sobrescriba el destino.

La ruta elegida proviene del diálogo del host, no de un payload IPC arbitrario. El control de la carpeta reutiliza la validación E1/E2. No se afirma aislamiento frente a un proceso hostil del SO que cambie directorios concurrentemente ni durabilidad ante corte físico. El archivo no se registra como otro Resource ni queda sincronizado; importarlo después exige otra revisión explícita. Copiar el buffer es una acción local de la persona, y no modifica el proyecto ni envía datos a IA.

## Panel de trazabilidad

Proyección regenerable del snapshot activo: historias, tareas, criterios y evidencias enlazan IDs canónicos, dependencias, referencias y documento de contenido. Evidencias muestran su recurso/entidad de origen o commit referenciado; cada placement de la misma tarea aparece con su workspace y acción de ubicación. Los vínculos internos permiten saltar dentro del panel con foco de teclado. No hay un grafo persistido paralelo, acceso de red o lectura implícita de archivos montados.

Los destinos ausentes se marcan como referencias rotas; comprobar que el descriptor existe no certifica sus bytes, veracidad, ejecución o existencia remota de un commit. Los criterios sin evidencia siguen la regla E4-C2: evidencia válida vinculada por una tarea que use ese criterio; una evidencia suelta no acredita cobertura. El informe no demuestra cobertura completa ni corrección semántica. Las conexiones visuales no se recorren.

## Evidencia

- Dominio: fixture persistente, round-trip de los cinco estados, Unicode/BOM/CRLF/escapes y campos desconocidos; revisión/ID en conflicto; versión, sintaxis, ciclo, referencia rota, límite UTF-8 y proyecto ajeno. Trazabilidad con dos representaciones de una tarea y destinos rotos.
- Store temporal Windows: preview/no-op sin escribir, importación y reapertura con actor autenticado, revisión, referencias conservadas, nueva tarea por ID, rechazo de evidencia obligatoria, tokens obsoletos/reproducidos, sesión cerrada y revocación de `task.edit`/`export`.
- Electron: selección/exportación, enrutado al portapapeles del host (simulado para no tocar el portapapeles del usuario), guardado nativo/cancelación/colisión sin sobrescribir, carga de un File Markdown, comparación sin mutar, importación explícita, conflicto conservando actual, fuente rota conservada, proyecto ajeno, panel y foco, IPC estricto. El smoke de planificación conserva además su cobertura anterior de nodos/evidencias/propuestas.

Comandos/resultados y cierre acotado de E4: [evidence.md](evidence.md). No se implementa sincronización de archivos exportados, importación general de cualquier checklist, nuevos proveedores IA, semántica inferida de requisitos, edición/creación de evidencia desde metadata ni borrado por omisión.
