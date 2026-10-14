# A3

A3 será una aplicación de escritorio local para organizar documentación, recursos y diagramas sobre workspaces visuales. El repositorio contiene E0 (contratos y comprobaciones de viabilidad) y E1-A: una base Electron con navegación inicial; los servicios de proyecto se incorporarán después.

Tecnologías previstas: Electron, React, TypeScript, Vite, React Flow, Milkdown y CodeMirror 6. El formato propio de dominio usa JSON y Markdown, independiente del estado de esas bibliotecas.

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

`schemas/e0/` contiene diez esquemas: definiciones comunes, proyecto, entidad, recurso, relación, workspace, placement, arista visual, vista de relación y paquete declarativo. `fixtures/e0/project/` conserva la estructura de proyecto con dos workspaces, dos entidades y una sola fuente Markdown compartida por dos placements. La relación semántica y la arista visual son documentos distintos; se incluye una RelationView.

E0-B1 es un spike local reproducible en `experiments/e0/chat-web/`. Usa dos `WebContentsView` como vistas hermanas de una `BaseWindow`: una UI local pequeña y una vista remota sin preload. La sesión web es en memoria; no se persiste en el proyecto. La interfaz copia una selección y un prompt al portapapeles, y la persona decide cuándo pegarlos en ChatGPT. Consulta el resultado y los límites de evidencia en `docs/e0/compatibility/chat-web.md`.

E0-B2 es un spike local de protocolo en `experiments/e0/codex-app-server/`. Arranca el Codex CLI instalado con un perfil temporal aislado y verifica `initialize` sin login, sin token y sin consultas de modelo. La evidencia, los requisitos de OAuth y las pruebas pendientes están en `docs/e0/compatibility/codex-app-server.md`. Reproducirlo requiere un Codex CLI instalado: `npm test --prefix experiments/e0/codex-app-server`.

`fixtures/e0/invalid-cases.json` describe mutaciones negativas sobre los fixtures base; el arnés las materializa solo en memoria. La segunda validación recorre únicamente el grafo sintético del fixture, no es un lector general de proyectos: no resuelve montajes, paquetes, symlinks, reglas técnicas ni permisos. El validador no descarga referencias remotas. Las pruebas no acreditan transacciones, edición de UI, migraciones ejecutables ni recuperación ante fallos.
