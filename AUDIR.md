# Registro de trabajo y correcciones

## 2026-10-14 — E1-A

Se verificó raíz Git, árbol limpio y origin `https://github.com/Sigilo-dev/A3.git`. El remoto conservaba E0-E `a6d8c13` en `codex/e0-foundation`; `main` aún contenía solo bootstrap. Se creó `codex/e1-base` desde E0-E sin alterar main ni historia. No se modificaron los documentos locales de especificación/prompts ni los locks de los experimentos.

Se convirtió el package raíz en workspace npm y se añadió `apps/desktop`: main/preload/renderer separados, consulta de estado tipada, sandbox/contextIsolation/Node desactivado en renderer, assets locales por protocolo a3, CSP, rechazo de permisos, ventanas nuevas y navegación externa. La UI ofrece navegación real a secciones placeholder, actividad y estado del host; no implementa servicios de proyecto. Fallos de arranque muestran un diálogo nativo; errores de consulta/render tienen recuperación visible. La última ventana cierra Electron y el handler se retira al salir.

Se fijaron Electron 44.7.2, React/React DOM 19.3.1 y Vite 8.3.4 de E0, más versiones estables verificadas por registry/peers: electron-vite 6.0.0, electron-builder 26.15.3, TypeScript 7.0.2, plugin React 6.1.2 y tipos Node/React. Las decisiones y licencias están en `docs/adr/0001-desktop-shell.md` y `docs/e1/desktop-foundation.md`. Se añadió MIT para el código original y se incluyeron avisos del runtime y textos React/React DOM/Scheduler en el directorio de prueba. No se empaquetaron motores externos, herramientas de build ni credenciales.

Validación final en Windows 10 x64 build 19045, Node host 24.13.1/npm 11.10.0:

- `npm ci --no-audit --no-fund`: instalación limpia desde el lock, exit 0.
- `npm run typecheck` y `npm run build`: exit 0; también se ejecutan como parte de `npm run pack:win`.
- `npm test`: 34 contratos E0 aprobados.
- `npm run test:desktop`: arranque seguro, API limitada, rechazo de IPC de otra ventana, navegación y panel, CSP de producción, bloqueo de popups/navegación externa y cierre normal. Renderer/preload ausentes mostraron el error de inicio y salida 1 en fixtures temporales.
- `npm run pack:win`: directorio x64 con ASAR, recursos de versión A3, sin firma/publicación; exit 0. `node apps/desktop/test/run-smoke.mjs --packaged` pasó sobre el ASAR con Electron 44.7.2.
- `node apps/desktop/test/run-smoke.mjs --development`: Vite local + main compilado, renderer aislado y cierre; exit 0. El servidor propio terminó y los perfiles temporales se eliminaron.
- Inspección del paquete: ASAR 238,508 bytes, solo assets compilados y package.json; no node_modules ni fuentes/tests. EXE ProductName A3, ProductVersion 0.1.0.0 y FileVersion 0.1.0-dev.0. Electron incluye Chromium 152.0.7977.149 y Node 24.21.0.
- Se revisó visualmente una captura de la interfaz y `git diff --check` no detectó errores de whitespace.

Correcciones durante elaboración: una consulta inicial de metadata para `@types/node/24` devolvió 404 (se resolvió el mayor 24 y se fijó 24.19.2); un glob de rg pasado como ruta literal no funcionó en PowerShell y se sustituyó por `-g`. El primer build no minificó renderer (575.71 kB); se activó minificación y quedó en 224.84 kB. El panel de actividad extendía la página: se limitó el grid al viewport con scroll dentro de paneles. La configuración inicial omitía edición de recursos del EXE; se cambió a `signExecutable: false`, manteniendo metadata y evitando firma. React se movió a deps de build porque ya se incorpora al bundle, eliminando copias redundantes del paquete. Se recompilaron y verificaron los resultados tras estos cambios.

`npm audit` reportó 8 alertas moderadas en dependencias de desarrollo de electron-builder, derivadas de sprintf-js/roarr/global-agent; no hubo altas/críticas. No se aplicó el downgrade automático propuesto a builder 26.5.0 ni overrides sin prueba. Hay advertencias de paquetes deprecados en esa cadena; permanecen como límite del toolchain, que no se distribuye en el ASAR. La revisión de metadata y avisos no equivale a auditoría legal del instalador final.

A3-050 queda abierto: esta entrega proporciona evidencia de base compilada y arranque, no instalador, actualización/rollback, datos de proyectos reales ni aceptación Windows 11. La versión leída por el harness corresponde al Electron ejecutor del test; no se confundió con la versión del EXE, cuyos recursos se inspeccionaron por separado. El commit usa `build(desktop): bootstrap electron application`; la publicación corresponde solo a `codex/e1-base`.

## 2026-10-14 — E0-A

Se verificó la raíz `C:/Users/VR/Documents/ChatGPT/A3`, sin commits, rama inicial `master`, sin remotos y solo dos archivos de planificación sin seguimiento. `git ls-remote` confirmó que el destino autorizado no tenía refs. Se añadió `origin` a `https://github.com/Sigilo-dev/A3.git`, se inició `main` y se publicó el bootstrap `97752ae` con README y exclusiones. Luego se creó `codex/e0-foundation` desde main.

La orden de publicar especificación/prompts en el bootstrap contradice la prohibición expresa al inicio del pedido. Se respetó esta última: ambos archivos siguen locales, intactos y excluidos. Solo se versionan contratos, README y este registro como Markdown; el Markdown de ejemplo es también un README descriptivo del fixture.

Durante el cierre apareció `A3_E1_E2_PROMPTS.md`, ajeno a esta tarea. No se editó ni incorporó; se amplió la exclusión a `/A3_*PROMPTS.md` para respetar la prohibición de publicar planificación futura.

Se leyeron las secciones de la especificación maestra 1.0.0, especialmente 4, 6, 7, 8, 24, 28 y 30. Se crearon tres documentos de contrato, diez esquemas, un proyecto sintético, un manifiesto declarativo, casos negativos y un arnés pequeño de validación. No se creó aplicación, monorepo ni dependencia productiva.

## Herramienta y licencias

No existían dependencias. Se eligió Ajv, ya previsto por la especificación, para evitar inventar un intérprete parcial de JSON Schema. Es dependencia de desarrollo exacta 8.20.0; se usa `node:test` del runtime y no se añade framework de pruebas.

Se consultaron el 2026-10-14 la [licencia oficial de Ajv](https://ajv.js.org/license.html) y su [soporte de JSON Schema](https://ajv.js.org/json-schema.html). También se leyó el archivo LICENSE instalado de Ajv y la metadata de los paquetes fijados:

| Paquete | Versión | Licencia declarada |
|---|---|---|
| ajv | 8.20.0 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.8 | BSD-3-Clause |
| json-schema-traverse | 1.0.0 | MIT |
| require-from-string | 2.0.2 | MIT |

`npm install --ignore-scripts` instaló cinco paquetes y reportó cero vulnerabilidades en esa consulta. Las dependencias no se incluyen en Git. Esta revisión permite el spike; no certifica licencias de una distribución futura con Electron y binarios externos.

## Errores encontrados y prevención

| Problema | Corrección | Cómo evitar repetirlo |
|---|---|---|
| La lectura conjunta de especificación y prompts excedió el límite de salida. | Se leyó la especificación por bloques de secciones, recuperando los bloques truncados. | Acotar lecturas por encabezados y verificar truncamiento. |
| Primera ejecución: 20 pruebas pasaron y 14 fallaron por compilación del esquema Resource; Ajv `strictRequired` no reconocía `path` definido fuera de cada rama `oneOf`. | Se declararon en cada rama las propiedades requeridas con sus mismas restricciones, sin desactivar modo estricto. | Compilar todos los esquemas antes de interpretar fallos de fixtures; no ocultar errores relajando el validador. |
| Git avisó conversión futura LF/CRLF en archivos de configuración iniciales. | Se fijaron LF explícitos para JSON, Markdown y scripts con `.gitattributes`. | Verificar serialización de los fixtures y evitar depender del `autocrlf` del equipo. |

## Evidencia y límites

`npm test` terminó con **34 pruebas aprobadas, 0 fallidas** en Windows con Node.js 24.13.1/npm 11.10.0:

- Compilación estricta de los diez esquemas y aceptación de los documentos positivos.
- UTF-8 estricto, JSON serializado a dos espacios y LF final en esquemas/fixtures.
- 23 mutaciones negativas de forma, versiones, UUID, revisiones, namespace, rutas, ubicaciones, extremos y manifiesto.
- Seis casos que pasan esquema y fallan referencias: recurso, puerto, RelationView, workspace de arista, workspace predeterminado y archivo ausente.
- Una fuente Markdown compartida entre dos workspaces; preservación de campos desconocidos por el validador; ubicaciones mounted-file y remote-url como alternativas estructurales.

Las pruebas solo leen datos sintéticos locales y mutan copias en memoria. No prueban actualización de UI al editar contenido, persistencia transaccional, conflicto ejecutable por revisión, idempotencia durable, migraciones, aislamiento ni permisos. Preparan contratos relacionados con A3-003–005, A3-033, A3-041–042 y A3-045–048; ninguno de esos criterios completos se declara aprobado.

Revisión enfocada: separación entre fuente/vista, referencias de extremos, preservación de campos desconocidos, no ejecución de paquetes al abrir y límites de JSON Schema. Las decisiones pendientes están en el contrato de dominio y comandos: ámbitos de unicidad, hashes/revisión de contenido, ledger de idempotencia, redes IoT, versiones, variables, esquemas restantes y conservación de formato.

## 2026-10-14 — E0-B1

Se confirmó que el checkout y `origin` siguen siendo `https://github.com/Sigilo-dev/A3.git`, la rama `codex/e0-foundation` y el commit padre E0-A `b2cb39c`. El remoto `main` coincide con el bootstrap ya publicado; no se cambió ni reescribió.

Se consultaron documentos oficiales el 2026-10-14. Electron 44.7.2 era estable (Chromium 152.0.7977.149, Node.js 24.21.0); `BrowserView` está obsoleta desde Electron 29. Electron 44 hizo el portapapeles asíncrono, hallazgo aplicado al IPC del spike. Las fuentes y los límites para ChatGPT están citados en `docs/e0/compatibility/chat-web.md`.

Se revisó la licencia declarada en el lockfile de los 13 paquetes del spike, el `LICENSE` de Electron y `LICENSES.chromium.html`; no se obtuvo un binario de otra fuente. Tabla y límites de esta revisión están en la nota de compatibilidad.

Se creó una prueba temporal aislada con `WebContentsView`, UI local y vista remota sin preload; Electron está fijado como dependencia local del spike, nunca como dependencia raíz/de producción. `npm test --prefix experiments/e0/chat-web` terminó con exit code 0: flags seguros, ausencia de bridge/Node, intento de leer un archivo del fixture bloqueado, clipboard real, historial local y carga pública `https://chatgpt.com` comprobados. El runner eliminó el perfil temporal de esa ejecución. La prueba no entró, no inspeccionó cookies, no envió prompts ni automatizó la página. Los reintentos fallidos durante el desarrollo del harness se corrigieron; los detalles están en el historial del spike, sin datos de sesión incluidos.

**Errores y corrección:** (1) `npm install --ignore-scripts` no preparó el binario de Electron; se ejecutó instalación normal y se fijó la versión. (2) la primera prueba leyó clipboard inmediatamente, pero Electron 44 ahora devuelve promesas; se esperó `writeText` y `readText`. (3) la verificación de acceso a archivos dejó un `fetch(file://)` pendiente; se añadió timeout al fixture hostil. (4) una carga `await` estaba dentro de callback no asíncrono; se declaró el callback `async`. (5) el reporter buscó el texto `copiado` distinguiendo mayúsculas y clasificó como fallo dos mensajes correctos; ahora compara sin distinguir caja. El test runner recoge el resultado y limpia su perfil aunque las aserciones fallen.

No se acreditan A3-026 ni A3-027 completos: la integración pública cargó, pero no se hizo login o paste/send real. La sonda local no prueba todas las barreras de Chromium/Windows. Carpetas de perfil/cache de pruebas abortadas durante el desarrollo quedaron en `%TEMP%` y `%APPDATA%`; no se introdujeron credenciales y la sesión ChatGPT usada era en memoria. Se intentó retirar esos directorios propios del spike, pero el host bloqueó la eliminación recursiva fuera del workspace. El runner reproducible ya elimina el perfil de ejecuciones completas; no persisten procesos Electron del spike.

## 2026-10-14 — E0-B2

Antes de editar se confirmó la raíz `C:/Users/VR/Documents/ChatGPT/A3`, el remoto `origin` con fetch/push a `https://github.com/Sigilo-dev/A3.git`, la rama `codex/e0-foundation` y estado limpio. El `HEAD` remoto por defecto continúa siendo `main` en `97752ae`; no se modificó. Se leyeron la especificación maestra 1.0.0 §§20, 21, 28 y 30 (incluidos A3-028–030) y los tres contratos E0-A. La especificación y los prompts permanecen locales.

Se consultaron el 2026-10-14 las guías oficiales de Sign in with ChatGPT para apps OSS, registro OAuth, sesiones, app-server, modelos, errores y limitaciones, más la guía general del protocolo y componentes open source de Codex. Los enlaces y requisitos están en `docs/e0/compatibility/codex-app-server.md`. La documentación actual permite una app abierta/local que usa el plan del usuario mediante OAuth sin clave API del desarrollador; exige registro dinámico por cuenta, permiso `chatgpt.tokens.use.direct` y usuario elegible. El plan/modelo real no se determina por el catálogo. La guía no especifica una versión semántica separada del protocolo ni la licencia concreta del artefacto que A3 empaquetaría; hay que fijar CLI, generar su schema y revisar licencias de esa release antes de distribuirla.

En el entorno existe Codex CLI `0.162.0-alpha.17.2`. El spike `experiments/e0/codex-app-server/` inicia `app-server` con perfil temporal vacío y entorno de variables reducido; `npm test --prefix experiments/e0/codex-app-server` pasó. La prueba solo hace `initialize`/`initialized` por stdio sin credenciales. No abrió una cuenta, no pidió ni guardó tokens, no consultó el endpoint de inferencia y no probó catálogo, turnos, renovación, límites o reanudación. No se generaron ni usaron API keys.

**Errores y corrección:** al probar por primera vez con stdin ya canalizado, el proceso descartó mensajes que llegaron antes de abrir el transporte (`dropping message for disconnected connection`). El arnés ahora espera el inicio del proceso, envía `initialize`, espera su respuesta, y solo entonces emite `initialized`. La primera limpieza de una carpeta temporal chocó con un archivo aún ocupado; el arnés espera al evento `close` del proceso hijo y reintenta la limpieza. La nueva ejecución terminó con código 0 y limpió su perfil temporal.

Los hallazgos respaldan la viabilidad de A3-028, no su aceptación: OAuth, inferencia y desconexión reales quedan por probar con una cuenta elegible del propietario/usuario. A3-029 permanece abierto porque no se provocaron límites, vencimiento ni denegación de modelo. A3-030 permanece abierto porque `thread/resume` no prueba deduplicación de efectos A3; siguen vigentes `operationId`, revisiones y recuperación del contrato E0-A. La autorización de OAuth no amplía permisos locales del agente.

## 2026-10-14 — E0-C1

Antes de editar se confirmó la raíz `C:/Users/VR/Documents/ChatGPT/A3`, `origin` con fetch/push en `https://github.com/Sigilo-dev/A3.git`, rama `codex/e0-foundation` siguiendo la rama remota y estado limpio. `main`/`origin/main` permanecieron en `97752ae`; no se reescribió ni cambió el destino. Se leyeron la especificación maestra 1.0.0 §§7, 8, 21, 28 y 30 y los contratos E0-A de dominio, comandos y migración.

Se consultó el 2026-10-14 documentación oficial de Node.js v24, Electron y Microsoft Windows sobre `sync`/`datasync`, `rename`, creación `wx`, `FlushFileBuffers`, `ReplaceFileW`, `MoveFileExW`/`MOVEFILE_WRITE_THROUGH` y rutas largas. La prueba usó Windows 10 Pro 10.0.19045, volumen temporal C: NTFS, Node.js v24.13.1 y npm 11.10.0. No se ejecutó Electron. Las fuentes, sus versiones y las limitaciones están en `docs/e0/compatibility/windows-storage-recovery.md`.

El arnés `experiments/e0/windows-storage/` usa solo APIs integradas de Node y genera todo bajo un directorio `%TEMP%` con prefijo aleatorio que limpia en `finally`. No creó dependencias ni cambió datos del proyecto. `npm test --prefix experiments/e0/windows-storage` pasó tres veces, incluida la versión final: 13 casos por ejecución, cero fallidos. Se verificaron JSON UTF-8 y nombres Unicode, temporales en el mismo volumen, sustitución de dos destinos existentes, revisiones 1→2, hashes SHA-256, journal con copias y eventos, rutas de 336 caracteres, creación exclusiva `wx`, archivos sincronizados y conservación diagnóstica de JSON inválido. `fsyncSync`/`fdatasyncSync` del archivo devolvieron éxito; `fsyncSync` sobre directorio dio `EPERM`.

Se inyectó `process.exit(86)` antes y después de cada uno de los dos reemplazos, antes del commit y después del marcador de commit. Tras iniciar otro proceso, todos los casos sin commit restauraron ambos hashes anteriores; con commit se conservaron ambos hashes nuevos. Una edición externa previa detuvo la aplicación con `REVISION_CONFLICT`; una edición externa después del primer reemplazo fue preservada, la escritura propia se revirtió y recovery informó conflicto. No se ejecutó una migración ni una prueba de permisos.

**Errores y correcciones:** la carpeta no permite sincronizarse con `fsync` (`EPERM`). Se dejó el resultado explícito como límite de durabilidad de directorio, no se ocultó mediante reintentos ni se asumió que el flush de archivos hace durable el rename. La colisión `wx` devolvió `EEXIST`, pero esto prueba solo creación exclusiva de lockfile; no se promociona como bloqueo del kernel ni prueba de propietario vivo. La ruta larga funcionó con este Node/host, sin atribuirlo a una política o manifiesto que no se inspeccionó individualmente. No hubo fallos de aserción en las ejecuciones finales.

La terminación de proceso y la recuperación por hashes son evidencia parcial para A3-046/047; el parseo sintético aislado es parcial para A3-045. No se completan A3-001–003 ni A3-045–048: no hubo aplicación, importación, portabilidad entre equipos, UI de conflicto/restauración, watcher, migración ni recuperación interrumpida. Sobre todo, no se cortó la alimentación ni se reinició el sistema; **no se probó ni se declara durabilidad ante pérdida real de energía**. Las entradas de directorio, journal truncado y la reanudación de un rollback también quedan para un ensayo y ADR posteriores.

## 2026-10-14 — E0-C2

Antes de editar se confirmó la raíz `C:/Users/VR/Documents/ChatGPT/A3`, `origin` con fetch/push en `https://github.com/Sigilo-dev/A3.git`, rama `codex/e0-foundation` y estado limpio. Se conservó `main`/`origin/main`; no se modificó el remoto ni se elevó el proceso. Se leyeron la especificación maestra 1.0.0 §§8, 20–21, 24 y 30, los contratos E0-A y el resultado E0-C1.

Se consultaron el 2026-10-14 las páginas oficiales de Node.js v24 y Microsoft sobre AppContainer/LPAC, tokens restringidos, Job Objects, creación/seguridad de procesos y aislamiento Win32 empaquetado. El host era Windows 10 Pro 10.0.19045, Node.js v24.13.1 y npm 11.10.0. No había launcher nativo de aislamiento en el repo. La consulta de la característica opcional de Windows requirió elevación; no se elevó ni se concluyó que la plataforma no disponga de AppContainer clásico.

`experiments/e0/windows-isolation/` usa solo APIs integradas de Node y crea/limpia una carpeta única dentro de `%TEMP%`. `npm test --prefix experiments/e0/windows-isolation` pasó en la ejecución final: 6 casos, cero fallidos. El host de prueba leyó/escribió dentro de la raíz y negó `..`, junction y acceso tras revocación. Un proceso hijo normal, con entorno reducido pero token de usuario ordinario, leyó y escribió los fixtures hermanos fuera de la raíz por recorrido relativo y junction; lo siguió haciendo después de revocar la política lógica del host. Se probó el fallo cerrado con isolation no disponible solo como simulación. No se contactó red ni servicios, y no se probaron AppContainer, tokens restringidos, ACL del producto, Job Objects o revocación de un proceso hostil.

**Errores y corrección:** la primera ejecución del harness dejó el proceso hijo esperando porque cerrar `readline` no terminaba explícitamente la entrada estándar canalizada. El comando venció su timeout y quedaron vivos únicamente el runner y el hijo creados por esa ejecución. Se verificaron sus command lines, se detuvieron esos dos PID concretos y se eliminó solo la carpeta `a3-e0-c2-*` verificada bajo `%TEMP%`. El fixture ahora responde al cierre y sale explícitamente. Al retirar la ruta temporal de la salida para evitar incluir el nombre de usuario, una primera rerun comparó el marcador redactado con la ruta real; se corrigió manteniendo la ruta solo internamente y redactándola en el reporte. La nueva ejecución final terminó con exit 0 y `tempDataCleaned: true`. Regla para futuros harness de procesos: esperar `close` y cerrar/terminar de manera explícita stdin y el proceso antes de limpiar temporales; nunca borrar un directorio calculado sin verificar que sea el prefijo temporal propio.

A3-024 es parcial: se rechazaron escapes en el host de prueba, pero el hijo los atravesó. A3-031–032 se ejercitaron como guardas y política local simuladas, no en el broker A3. A3-033 no se probó y debe seguir usando validación transaccional con revisión/hash del servicio de proyecto. A3-043 no ejecutó plugins; el contrato declarativo E0-A permanece inerte. La matriz y la decisión de fallo cerrado están en `docs/e0/compatibility/windows-process-isolation.md`: procesos y red arbitrarios quedan deshabilitados hasta integrar y verificar una frontera del sistema; staging ordinario con el mismo usuario no cuenta como aislamiento.

## 2026-10-14 — E0-D1

Antes de editar se verificaron la raíz del repositorio, origin con fetch/push a https://github.com/Sigilo-dev/A3.git, la rama codex/e0-foundation y el estado de Git. El checkout seguía a origin/codex/e0-foundation; main no se modificó. Se leyeron A3 1.0.0 §§4, 10, 12, 14, 26 y 30 y los contratos E0-A de dominio, comandos y extensiones.

Se consultaron el 2026-10-14 las guías oficiales de Milkdown/Crepe, CodeMirror 6, React Flow y Perfect Freehand. npm view verificó versiones estables publicadas y licencia declarada; package-lock.json fija el árbol local. Los ocho paquetes directos del spike declaran MIT. La prueba no hizo auditoría legal de licencias de cada dependencia transitiva ni de una futura distribución Electron.

El spike aislado usa Vite/React, dos controles editoriales separados sobre un Markdown idéntico, un canvas React Flow con strokes dibujados por Perfect Freehand y exportadores locales. No ejecuta Electron ni escribe recursos del proyecto. En UI se guardó cada editor sin tocar contenido. CodeMirror devolvió la misma secuencia de texto; no se midieron bytes leídos/escritos en archivo. Milkdown normalizó la fuente y convirtió el wikilink A3 en texto con corchetes escapados; el bloque ::: conservó algunos tokens legibles pero se convirtió a contenido ordinario, no a bloque opaco. La etiqueta visible del spike se corrigió para no llamar a eso preservación estructural. No se editaron dos copias en paralelo ni se probó sincronización, conflictos o undo compartido.

En el canvas se movieron dos nodos, se conectaron con una arista visual, se dibujó un trazo, se aumentó el zoom y se guardó/reabrió un snapshot con localStorage del origen local. Al cambiar zoom de 1.00 a 1.20 y 1.44, el arreglo de puntos de flujo permaneció igual. Al reabrir el snapshot, el trazo mantuvo todos sus puntos y el cálculo reportó 0 px de desplazamiento en pantalla. Esto es una interacción de una página de prueba, no demuestra persistencia, undo/redo ni coordinación con selección de producción.

El exportador SVG reportó dos textos y dos paths, sin image ni foreignObject: texto, nodos, arista y contorno del trazo quedan como elementos vectoriales. El exportador PNG produjo una imagen 1920×1120 a escala 2; en ella todo se rasteriza. Se construyó desde una vista sintética y no se exportaron selección, grupos, workspace completo, transparencias o posters multimedia como exige validar A3.

**Errores de prueba y corrección:** la primera compilación ocurrió antes de terminar src/main.jsx y falló porque faltaba ese módulo; tras completar el arnés, npm run build pasó. Al cambiar la etiqueta de preservación de CodeMirror, una edición inicial alcanzó también el estado de inicio; se restauró el estado listo y se volvió a comprobar en navegador. Al probar Milkdown se observó serialización no equivalente pese a no editar; se registró como fallo para la garantía de no-op y se cambió el reporte de UI para separar la conservación del texto de la conservación del bloque. El build también emitió advertencia de chunk grande; el CSS de Crepe incluye muchos archivos de fuente KaTeX y el JavaScript generado superó el umbral predeterminado de Vite.  No es una medición de rendimiento en Electron. La primera repetición de npm ci no pudo reemplazar el binario de Rolldown porque el servidor Vite propio seguía abierto; se detuvo ese servidor y la instalación limpia del lock terminó. npm audit reportó cuatro avisos low en el árbol, correspondientes a un único advisory de KaTeX 0.18.1 traído por la ruta de matemáticas de Crepe; la nota enlaza el advisory. No se aplicó downgrade mayor ni override sin probar compatibilidad matemática.

Las versiones y fuentes se listan en docs/e0/compatibility/editors-canvas-export.md. A3-006 solo tiene selección/movimiento/conexión simples; no se probaron alinear, agrupar, contraer, redimensionar o deshacer, así que sigue abierto. A3-007 tiene evidencia parcial de coordenadas mundo y reabrir snapshot, sin prueba de presión real, undo o persistencia de proyecto. A3-009 falla su subcaso de conservación de fuente con Milkdown; CodeMirror solo preservó la cadena, no implementó formato visual ni edición simultánea. A3-016 no se comparó con referencia aprobada. A3-017 tiene evidencia parcial para una vista pequeña SVG/PNG únicamente. A3-008 y A3-052 no se probaron; no se declara accesibilidad. La nota enumera el trabajo de integración pendiente y no presenta criterios parciales como completos.
