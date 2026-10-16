# E2-E1 · visor/editor de código

Trazabilidad: **A3-011**; especificación §§9, 12.3, 18, 21. Base: `80538fd` (E2-D2) en `codex/e2-canvas`. Contratos: Resource E0-A; evidencia E0-C2 y E0-D1; broker, rutas, escritor/journal y codificación de E1. Decisión: [ADR 0010](../adr/0010-code-editor.md).

## Uso y alcance

En Archivos, seleccionar un archivo y pulsar **Abrir editor de código**. Los recursos montados disponibles ofrecen **Ver código · solo lectura**. Un nodo de código ofrece el mismo editor usando su entity/resource ID. El diálogo incluye lenguaje automático o selección explícita, números de línea, búsqueda/reemplazo (`Ctrl+F`), plegado en margen, selección y edición por teclado, indentación de dos espacios con reglas del lenguaje y guardado explícito (`Ctrl+S`). Cambiar el resaltado no modifica los bytes.

El editor y el lenguaje se cargan bajo demanda; los nodos mantienen una vista previa ligera. Guardar actualiza las vistas previas visibles y el listado del explorador, sin guardar estado de CodeMirror en el proyecto. Cerrar un borrador pide guardar, continuar o descartar. Cancelar el cierre nativo conserva el escritor para seguir trabajando. No hay ejecución de código, terminal, compilador, depurador, descargas ni carga de extensiones desde el proyecto.

## Lenguajes y dependencias fijadas

Todos los paquetes nuevos son módulos oficiales de CodeMirror con licencia MIT, verificada en el registro npm y en el paquete instalado. Se guardan versiones exactas y `package-lock.json`.

| Lenguaje | Módulo | Versión |
| --- | --- | --- |
| Markdown | `@codemirror/lang-markdown` (existente) | 6.5.2 |
| JSON | `@codemirror/lang-json` | 6.0.2 |
| JavaScript / TypeScript, JSX / TSX | `@codemirror/lang-javascript` | 6.2.5 |
| Python | `@codemirror/lang-python` | 6.2.1 |
| Rust | `@codemirror/lang-rust` | 6.0.2 |
| C / C++ | `@codemirror/lang-cpp` | 6.0.3 |
| HTML | `@codemirror/lang-html` | 6.4.12 |
| CSS | `@codemirror/lang-css` | 6.3.1 |
| YAML | `@codemirror/lang-yaml` | 6.1.3 |
| TOML | `@codemirror/legacy-modes/mode/toml` | 6.5.5 |
| SQL | `@codemirror/lang-sql` | 6.10.0 |
| Búsqueda / reemplazo | `@codemirror/search` | 6.7.2 |

Se reutilizan `codemirror` 6.0.2, `@codemirror/state` 6.7.6 y `@codemirror/language` 6.13.1. `basicSetup` proporciona selección, historial del buffer, números de línea, búsqueda y controles de plegado. Los parsers aportan plegado/indentación donde existen; TOML usa tokens de stream y no garantiza plegado estructural. Otros archivos son texto plano tras detección de binario y comprobación de codificación. El nombre/extensión no autoriza interpretar bytes arbitrarios.

## Conservación y permisos

| Entrada | Lectura / edición |
| --- | --- |
| UTF-8 estricto, sin BOM o con BOM | Editable si el broker y el store lo permiten; conserva BOM y LF/CRLF uniforme. |
| UTF-16 LE/BE con BOM | Editable con comprobación exacta de ida/vuelta; conserva endianness, BOM y LF/CRLF. |
| Finales mezclados o CR aislado | Texto visible, solo lectura con motivo. |
| Codificación inválida o no reconocida | Solo información del archivo; sin caracteres de sustitución ni sobrescritura. |
| Binario reconocido o con controles | Sin editor de texto; conserva los bytes. La detección es conservadora, no un identificador universal de formatos. |
| Archivo mayor de 2 MiB | Diagnóstico de límite; no se abre como vacío ni se escribe. |
| Metadatos A3 / fuente canónica de dibujo | Solo lectura o excluidos; se necesita el servicio/editor de su contrato. |
| Montaje externo | Solo lectura efectiva por E0-C2, aunque una política solicite más acceso. |
| Permiso revocado, sesión anterior o conflicto externo pendiente | El host deniega el siguiente guardado. |

Abrir/cerrar o guardar el mismo buffer no toca bytes, revisiones ni crea descriptores. Una edición usa la codificación ya comprobada; cambiar el convenio de EOL, introducir controles binarios o Unicode incompleto se rechaza. El primer guardado modificado de un archivo no registrado crea su descriptor y contenido en una transacción recuperable. No se promete atomicidad de varios archivos ni durabilidad ante un corte eléctrico no ensayado.

## Conflictos

El host valida identidad, revisión/hash y permisos antes de preparar y confirmar. Dos vistas no se sobrescriben: la segunda revisión obsoleta recibe `REVISION_CONFLICT`. Comparar conserva el borrador y muestra la fuente actual. **Usar guardada** descarta explícitamente el borrador; **Conservar borrador sobre guardada** solicita una nueva escritura contra la revisión comparada, sin force ni fusión implícita. Una modificación/reemplazo externo preserva la versión del disco y bloquea escritura si el store tiene conflicto pendiente. Reabrir el proyecto no recupera por sí solo un borrador en memoria: copiarlo antes de cerrar si se quiere conservar.

## Verificación

- `npm test`: contratos E0, dominio, store, viewport y parsers/licencias de lenguajes. Los tests del editor usan carpetas temporales.
- `npm run build --workspace @a3/desktop`: TypeScript de host/renderer y bundles Electron/Vite.
- `npm run test:smoke --workspace @a3/desktop -- --editors-only`: ciclo local, Markdown y código en Electron con red bloqueada; excluye los gestos de canvas. `--markdown-only` conserva compatibilidad como alias de este recorrido.
- `npm audit --omit=dev`: revisión de dependencias de producción, sin actualizaciones masivas.

Escenarios dirigidos: los doce lenguajes y texto plano; tokens reales de resaltado; indentación/plegado JS, Python y JSON; UTF-8/BOM y UTF-16 LE/BE, Unicode y LF/CRLF; no-op exacto; registro al primer guardado; resource ID tras rename; vistas concurrentes; reemplazo externo; perfil revocado; montaje solo lectura/ausente/revocado; binario y codificación inválida; fuente administrada; apertura desde nodo y explorador, búsqueda/reemplazo y cierre cancelado. No se certifica un instalador de publicación ni ejecución de archivos.

Resultados observados en Windows: suite general `npm test` sin fallos; las nueve pruebas dirigidas finales del servicio de código y las cuatro de lenguajes/licencias pasan. Tipos y build de Electron pasan. El recorrido `--editors-only` pasa con aislamiento, CSP y validación de emisor, sin solicitudes de red. La auditoría de producción informa cero vulnerabilidades. Los gestos completos del canvas, el instalador y cortes eléctricos reales no se verifican en este bloque.
