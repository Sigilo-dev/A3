# A3

A3 será una aplicación de escritorio local para organizar documentación, recursos y diagramas sobre workspaces visuales. Este repositorio empieza con E0: contratos y comprobaciones de viabilidad; todavía no contiene una aplicación.

Tecnologías previstas: Electron, React, TypeScript, Vite, React Flow, Milkdown y CodeMirror 6. El formato propio de dominio usa JSON y Markdown, independiente del estado de esas bibliotecas.

La especificación y los prompts de planificación se mantienen localmente y no se publican. E0-A aporta contratos, JSON Schemas y fixtures comprobables, sin UI ni servicios de producción.

Contratos: [dominio e invariantes](docs/e0/contracts/domain.md), [comandos y migración](docs/e0/contracts/commands-and-migrations.md), [extensiones](docs/e0/contracts/extensions.md). El trabajo realizado y los errores corregidos están en [AUDIR.md](AUDIR.md).

Tecnologías realmente usadas: JSON Schema 2020-12, JSON/Markdown UTF-8, JavaScript sobre Node.js, Ajv 8.20.0 para E0-A y Electron 44.7.2 solo dentro del spike de E0-B1. E0-B2 usa módulos integrados de Node.js y el Codex CLI local, sin dependencias npm. Los spikes están aislados; no se añadieron dependencias al package raíz ni a una dependencia de producción.

E0-C1 añade una prueba de almacenamiento y recuperación en Windows en `experiments/e0/windows-storage/`, solo con módulos integrados de Node.js y datos temporales. Se ejecuta con `npm test --prefix experiments/e0/windows-storage`; resultados y límites están en [la nota de compatibilidad de almacenamiento](docs/e0/compatibility/windows-storage-recovery.md). No prueba cortes de energía ni implementa el project-store.

Para reproducir las comprobaciones desde la raíz, con Node.js y npm:

```sh
npm ci --ignore-scripts
npm test
```

Entorno comprobado: Windows, Node.js 24.13.1 y npm 11.10.0. El lock fija el árbol de dependencias del spike. No es una elección de versiones productivas.

`schemas/e0/` contiene diez esquemas: definiciones comunes, proyecto, entidad, recurso, relación, workspace, placement, arista visual, vista de relación y paquete declarativo. `fixtures/e0/project/` conserva la estructura de proyecto con dos workspaces, dos entidades y una sola fuente Markdown compartida por dos placements. La relación semántica y la arista visual son documentos distintos; se incluye una RelationView.

E0-B1 es un spike local reproducible en `experiments/e0/chat-web/`. Usa dos `WebContentsView` como vistas hermanas de una `BaseWindow`: una UI local pequeña y una vista remota sin preload. La sesión web es en memoria; no se persiste en el proyecto. La interfaz copia una selección y un prompt al portapapeles, y la persona decide cuándo pegarlos en ChatGPT. Consulta el resultado y los límites de evidencia en `docs/e0/compatibility/chat-web.md`.

E0-B2 es un spike local de protocolo en `experiments/e0/codex-app-server/`. Arranca el Codex CLI instalado con un perfil temporal aislado y verifica `initialize` sin login, sin token y sin consultas de modelo. La evidencia, los requisitos de OAuth y las pruebas pendientes están en `docs/e0/compatibility/codex-app-server.md`. Reproducirlo requiere un Codex CLI instalado: `npm test --prefix experiments/e0/codex-app-server`.

`fixtures/e0/invalid-cases.json` describe mutaciones negativas sobre los fixtures base; el arnés las materializa solo en memoria. La segunda validación recorre únicamente el grafo sintético del fixture, no es un lector general de proyectos: no resuelve montajes, paquetes, symlinks, reglas técnicas ni permisos. El validador no descarga referencias remotas. Las pruebas no acreditan transacciones, edición de UI, migraciones ejecutables ni recuperación ante fallos.
