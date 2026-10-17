# A3

A3 será una aplicación de escritorio local para organizar documentación, recursos y diagramas sobre workspaces visuales. El repositorio contiene E0 (contratos y comprobaciones de viabilidad), E1-A (base Electron con navegación inicial), E1-B (núcleo de dominio independiente), E1-C1 (codecs/lectura validada), E1-C2 (servicio escritor Windows y watcher), E1-D1 (journal local y recuperación por interrupción del proceso) y E1-D2 (snapshots, migraciones registradas y apertura degradada). La conexión del servicio a la interfaz sigue pendiente.

Tecnologías previstas: Electron, React, TypeScript, Vite, React Flow, Milkdown y CodeMirror 6. El formato propio de dominio usa JSON y Markdown, independiente del estado de esas bibliotecas.

E2-F2 conecta los enlaces y backlinks regenerables con focus, las referencias transaccionales al renombrar/mover, los menús de las operaciones existentes y los atajos editables. Consulta [uso, pruebas y límites](docs/e2/contextual-navigation.md).

E3-B1 incorpora el modelo nativo UML de clases, interfaces, enumeraciones, paquetes y seis relaciones semánticas, con inspector, compartimentos y persistencia compartida entre vistas. Consulta [subconjunto, pruebas y límites](docs/e3/e3-b1-uml.md); la conversión/exportación de otros formatos sigue pendiente.

E3-B2 incorpora el modelo entidad–relación separado de UML: tablas, campos, claves y cardinalidades persistentes, con exportador acotado a Mermaid ER. Consulta [subconjunto, pruebas y límites](docs/e3/e3-b2-er.md); la importación Mermaid y la exportación SQL siguen pendientes.

E3-G3 añade conversión local de audio/video con FFmpeg/ffprobe opcionales verificados, cinco perfiles comprobados y salidas nuevas confirmadas por el escritor. Consulta [configuración, pruebas y límites](docs/e3/audio-video-conversion.md) y la [evidencia consolidada E3](docs/e3/evidence.md).

E4-A1 añade variables tipadas por proyecto/workspace/entidad/ejecución, referencias por ID y bindings declarados con inspector de valor y ámbito efectivo. Consulta [contrato 1.1, pruebas y límites](docs/e4/typed-variables.md).

La especificación y los prompts de planificación se mantienen localmente y no se publican. E0-A aporta contratos, JSON Schemas y fixtures comprobables, sin UI ni servicios de producción.

Contratos: [dominio e invariantes](docs/e0/contracts/domain.md), [comandos y migración](docs/e0/contracts/commands-and-migrations.md), [extensiones](docs/e0/contracts/extensions.md). El trabajo realizado y los errores corregidos están en [AUDIR.md](AUDIR.md).

E0 usa JSON Schema 2020-12, JSON/Markdown UTF-8, JavaScript sobre Node.js y Ajv 8.20.0. E0-B2 usa módulos integrados de Node.js y el Codex CLI local, sin dependencias npm. Los spikes permanecen aislados con sus propios locks. E1-A añade `apps/desktop` como workspace npm y fija sus dependencias en el lock raíz; consulta [las decisiones del shell](docs/adr/0001-desktop-shell.md) y [la evidencia E1-A](docs/e1/desktop-foundation.md).

E0-C1 añade una prueba de almacenamiento y recuperación en Windows en `experiments/e0/windows-storage/`, solo con módulos integrados de Node.js y datos temporales. Se ejecuta con `npm test --prefix experiments/e0/windows-storage`; resultados y límites están en [la nota de compatibilidad de almacenamiento](docs/e0/compatibility/windows-storage-recovery.md). No prueba cortes de energía ni implementa el project-store.

E0-C2 añade `experiments/e0/windows-isolation/`, una prueba negativa de guardas de rutas y permisos heredados por un hijo Node en Windows. Usa únicamente módulos integrados, fixtures sintéticos temporales y no realiza conexiones de red. Se ejecuta con `npm test --prefix experiments/e0/windows-isolation`; los mecanismos del sistema no probados y la matriz de perfiles están en [la nota de aislamiento de procesos](docs/e0/compatibility/windows-process-isolation.md). No implementa un sandbox ni el broker de permisos.

E0-D1 añade el spike local experiments/e0/editors-canvas/: Milkdown/Crepe y CodeMirror sobre el mismo fixture Markdown, React Flow con Perfect Freehand, y exportadores SVG/PNG. Sus dependencias están fijadas solo en el package-lock.json del spike; no forman parte de la aplicación ni de dependencias productivas. La nota docs/e0/compatibility/editors-canvas-export.md incluye los resultados manuales y los límites.

Para instalar desde el lock raíz, con Node.js 24.13.1 y npm 11.10.0:

```sh
npm ci
npm test
```

Entorno comprobado: Windows 10 x64 (10.0.19045), Node.js 24.13.1 y npm 11.10.0. El lock raíz fija el árbol del workspace; los locks de experimentos se instalan por separado. La validación de distribución en Windows 11 continúa pendiente.

## Ejecutar la base de escritorio

Desde la raíz:

```sh
npm run dev          # Vite/HMR y Electron
npm run typecheck    # main/preload y renderer por separado
npm run build        # tipos y compilación de los tres entornos
npm start            # arranque desde out/ después de build
npm run test:desktop # smoke real con perfiles temporales y ventanas ocultas
npm run pack:win     # directorio Windows x64 de prueba; no publica
```

El ejecutable de prueba queda en `apps/desktop/dist/win-unpacked/A3.exe`. El renderer no dispone de Node ni de un IPC genérico. Las secciones de navegación indican su estado de placeholder; no crean ni guardan proyectos. Las instrucciones, licencias verificadas y límites de A3-050 están en [E1-A](docs/e1/desktop-foundation.md). `dist/` y `out/` se excluyen de Git.

## Núcleo de dominio

`packages/domain` exporta modelos, validación de documentos/grafo, resolución de variables y propuestas inmutables de comandos. Usa los esquemas E0 sin modificarlos y añade contratos E1 para grupos, colecciones, variables y definiciones declarativas. No lee archivos ni depende de React/Electron; el host aporta identidad, permisos y observaciones de contenido. La persistencia y el ledger de operaciones pertenecen a E1-C/D.

`npm run test:domain` compila y prueba el núcleo; `npm test` ejecuta contratos E0, dominio y store. `npm run build` compila dominio, store y desktop; `npm run typecheck` verifica los tres workspaces. Consulta [la ADR del núcleo](docs/adr/0002-domain-kernel.md) y [su API/evidencia](docs/e1/domain-kernel.md).

## Lectura y codecs de proyecto

`packages/project-store` lee el catálogo local con los esquemas/versiones E0/E1, separa diagnósticos de sintaxis/esquema/referencias y preserva JSON dañado o futuro para inspección. Un no-op devuelve bytes idénticos; edits explícitos producen JSON UTF-8 con claves ordenadas, indentación de dos espacios y LF final, sin eliminar datos desconocidos no editados. Markdown/código se leen como bytes originales. El servicio de Windows escribe con revisiones/hash, journal recuperable y snapshots locales bajo `.a3/local`; una corrupción localizada permite abrir vecinos válidos y exige reparación explícita. Las migraciones solo ejecutan cadenas registradas por la aplicación. La conexión del servicio a la interfaz sigue pendiente.

`npm run test:store` compila dominio/store y prueba codecs, lector, writer, recuperación, snapshots y migraciones con fixtures temporales. Consulta [la ADR de preservación](docs/adr/0003-project-codecs.md), [la API y límites E1-C1](docs/e1/project-serialization.md), [el contrato E1-C2/D1](docs/e1/project-writes.md) y [snapshots y migraciones E1-D2](docs/e1/snapshots-migrations.md). Las pruebas de proceso corren en Windows y no usan datos del usuario.

E1-C2 añade `openProjectService`: recursos por ID, políticas explícitas del host, planes de dominio/fuente, revisiones/hashes, temporales sincronizados y registro de intención/avance. Un dueño Windows arbitra procesos; ventanas comparten cola mediante leases. El watcher detecta cambios externos sin aceptarlos silenciosamente. E1-D1 recupera al abrir: confirma cuando todo coincide con la propuesta, revierte un lote parcial si no hubo cambios ajenos y deja un conflicto en solo lectura si la evidencia cambió. Los lotes siempre declaran `atomic: false`; el mecanismo de cada ruta también tiene una ventana sin nombre durante la aplicación. Consulta [API/evidencia E1-C2](docs/e1/project-writes.md), [contrato de recuperación](docs/e1/transaction-recovery.md) y [ADR del escritor](docs/adr/0004-project-writer.md).

E1-E1 añade concesiones locales por proyecto y perfiles Consultar, Proponer, Trabajar y Personalizado. El escritor acepta únicamente brokers emitidos por el host, devuelve denegaciones con capacidad faltante y audita decisiones sin contenido. E0-C2 no comprobó aislamiento suficiente para procesos ni red, así que procesos, red, paquetes, Git y exportación siguen deshabilitados; la UI de permisos y la conexión IPC/agent siguen pendientes. Consulta [broker y límites E1-E1](docs/e1/security-broker.md).

E1-E2 añade montajes locales de Windows vinculados a la ruta y UUID del proyecto en datos locales del host. El proyecto solo guarda `mountId` y ruta relativa; un clon no recibe la carpeta ni el permiso. Lectura, referencia y copia pasan por el broker y el escritor. La vista previa distingue copy, move y reference; move queda denegado porque todavía no hay borrado externo por handle sin seguir junctions. Consulta [rutas y montajes E1-E2](docs/e1/local-mounts.md).

E1-F1 conecta Proyectos con el host: crear o incorporar con preview/confirmación, abrir y renombrar, cerrar/reabrir recientes y localizar una carpeta movida. El bootstrap usa el journal E1; las carpetas previas conservan sus archivos. Recientes y aprobaciones quedan fuera del proyecto. Los nombres pendientes se guardan antes de cambiar o cerrar; los formatos futuros abren en solo lectura. Git continúa siendo opcional y su inicialización aún no está habilitada por el broker. Consulta [flujo local y errores E1-F1](docs/e1/local-projects.md).

`schemas/e0/` contiene diez esquemas: definiciones comunes, proyecto, entidad, recurso, relación, workspace, placement, arista visual, vista de relación y paquete declarativo. `fixtures/e0/project/` conserva la estructura de proyecto con dos workspaces, dos entidades y una sola fuente Markdown compartida por dos placements. La relación semántica y la arista visual son documentos distintos; se incluye una RelationView.

E0-B1 es un spike local reproducible en `experiments/e0/chat-web/`. Usa dos `WebContentsView` como vistas hermanas de una `BaseWindow`: una UI local pequeña y una vista remota sin preload. La sesión web es en memoria; no se persiste en el proyecto. La interfaz copia una selección y un prompt al portapapeles, y la persona decide cuándo pegarlos en ChatGPT. Consulta el resultado y los límites de evidencia en `docs/e0/compatibility/chat-web.md`.

E0-B2 es un spike local de protocolo en `experiments/e0/codex-app-server/`. Arranca el Codex CLI instalado con un perfil temporal aislado y verifica `initialize` sin login, sin token y sin consultas de modelo. La evidencia, los requisitos de OAuth y las pruebas pendientes están en `docs/e0/compatibility/codex-app-server.md`. Reproducirlo requiere un Codex CLI instalado: `npm test --prefix experiments/e0/codex-app-server`.

`fixtures/e0/invalid-cases.json` describe mutaciones negativas sobre los fixtures base; el arnés las materializa solo en memoria. La segunda validación recorre únicamente el grafo sintético del fixture, no es un lector general de proyectos: no resuelve montajes, paquetes, symlinks, reglas técnicas ni permisos. El validador no descarga referencias remotas. Las pruebas no acreditan transacciones, edición de UI, migraciones ejecutables ni recuperación ante fallos.
