# A3

A3 será una aplicación de escritorio local para organizar documentación, recursos y diagramas sobre workspaces visuales. Este repositorio empieza con E0: contratos y comprobaciones de viabilidad; todavía no contiene una aplicación.

Tecnologías previstas: Electron, React, TypeScript, Vite, React Flow, Milkdown y CodeMirror 6. El formato propio de dominio usa JSON y Markdown, independiente del estado de esas bibliotecas.

La especificación y los prompts de planificación se mantienen localmente y no se publican. E0-A aporta contratos, JSON Schemas y fixtures comprobables, sin UI ni servicios de producción.

Contratos: [dominio e invariantes](docs/e0/contracts/domain.md), [comandos y migración](docs/e0/contracts/commands-and-migrations.md), [extensiones](docs/e0/contracts/extensions.md). El trabajo realizado y los errores corregidos están en [AUDIR.md](AUDIR.md).

Tecnologías realmente usadas en este bloque: JSON Schema 2020-12, JSON/Markdown UTF-8, JavaScript sobre Node.js y Ajv 8.20.0 como única dependencia directa de desarrollo. No se han instalado las bibliotecas de la aplicación futura.

Para reproducir las comprobaciones desde la raíz, con Node.js y npm:

```sh
npm ci --ignore-scripts
npm test
```

Entorno comprobado: Windows, Node.js 24.13.1 y npm 11.10.0. El lock fija el árbol de dependencias del spike. No es una elección de versiones productivas.

`schemas/e0/` contiene diez esquemas: definiciones comunes, proyecto, entidad, recurso, relación, workspace, placement, arista visual, vista de relación y paquete declarativo. `fixtures/e0/project/` conserva la estructura de proyecto con dos workspaces, dos entidades y una sola fuente Markdown compartida por dos placements. La relación semántica y la arista visual son documentos distintos; se incluye una RelationView.

`fixtures/e0/invalid-cases.json` describe mutaciones negativas sobre los fixtures base; el arnés las materializa solo en memoria. La segunda validación recorre únicamente el grafo sintético del fixture, no es un lector general de proyectos: no resuelve montajes, paquetes, symlinks, reglas técnicas ni permisos. El validador no descarga referencias remotas. Las pruebas no acreditan transacciones, edición de UI, migraciones ejecutables ni recuperación ante fallos.
