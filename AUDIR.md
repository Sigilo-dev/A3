# Registro de trabajo y correcciones

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
