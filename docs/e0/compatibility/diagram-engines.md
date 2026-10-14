# E0-D2: compatibilidad de motores de diagramas en modo local

Consulta y ejecución: 2026-10-14, Windows 10 x64, Node.js 24.13.1, npm 11.10.0 y Eclipse Temurin OpenJDK 21.0.10. `plantuml`, `structurizr-cli` y Graphviz no estaban en `PATH`; Maven 3.9.15 estaba instalado pero no se necesitó. No se añadió ninguna dependencia a módulos de producción. Las versiones de este spike quedan fijadas en sus manifiestos y no son una recomendación de producción antes de E0-E.

La autoridad del original, de los datos estructurados de A3 y de la vista renderizada sigue el contrato de [dominio E0-A](../contracts/domain.md) y la sección 14 de `A3_ESPECIFICACION_MAESTRA.md`: esta prueba conserva cada fuente como bytes, trata una conversión estructurada como una capacidad separada y no infiere que un render pueda reconstruir la fuente. Ningún motor de esta nota demuestra round-trip universal.

## Resultado por motor

| Motor y archivo de fixture | Fuente y construcciones reconocidas/rechazadas | Conversión estructurada preservable | Resultado visual | Dependencia y licencia fijadas |
|---|---|---|---|---|
| Mermaid — `fixtures/mermaid/c4-context.mmd` | Fuente intacta, hash en el manifiesto. Mermaid 12.2.0 parseó/renderizó persona, sistema, sistema externo y relaciones. `@mermaid-js/parser` rechazó el tipo `c4` con `Unknown diagram type: c4`; no expuso AST para extraerlo. C4 es experimental según documentación oficial. | No se verificó conversión a A3. Preservar el original `.mmd` es la única conservación sin pérdida demostrada. | SVG `mermaid-c4-context.svg` (27,127 bytes), generado y visible en página local. | Mermaid 12.2.0 MIT; parser 2.0.1 MIT; Vite 8.3.4 MIT. Versiones en package lock. Fixture original sintético MIT. |
| Mermaid — `fixtures/mermaid/class-model.mmd` | Fuente intacta, hash en el manifiesto. Renderizó clases, campos, operación y multiplicidad. El parser separado rechazó el tipo `class` con `Unknown diagram type: class`; no hubo AST. | No se verificó conversión a A3. Preservar el original `.mmd`. | SVG `mermaid-class-model.svg` (21,673 bytes), generado y visible en página local. | Las mismas dependencias y licencias fijadas para Mermaid C4; fixture original sintético MIT. |
| PlantUML — `fixtures/plantuml/class-model.puml` | Fuente intacta, SHA-256 `cf2dd8…c06ce`. El JAR aceptó clase, campos, método, multiplicidad, título, `skinparam` y nota. No se detectaron construcciones ignoradas en este fixture; no se evaluaron otras extensiones. | No se probó parser/AST ni conversión a A3. El original conserva las directivas y la nota. | SVG `class-model.svg` (5,839 bytes) y PNG `class-model.png` (8,675 bytes). Graphviz mínimo `dot` 2.44.1 fue reportado por el propio JAR; no se instaló globalmente. | JAR oficial `plantuml-mit-1.2026.8.jar`, licencia MIT confirmada por `-license`; hash y URL en `binaries.lock.json`. Java 21 presente. Fixture original sintético MIT. |
| Structurizr — `fixtures/structurizr/workspace.dsl` | Fuente intacta. `validate` aceptó persona, sistema, contenedor, dos relaciones y vistas contexto/contenedores. No hay omisiones reportadas para este fixture. Un borrador anterior con relación directa padre→contenedor fue rechazado y corregido. Se quitó `theme default` porque descargaba un tema remoto y el acceso DNS falló. | Conversión DSL→JSON de Structurizr reproducida byte por byte (SHA-256 `84a001…a33d15`). No es conversión al modelo nativo A3. | Desde el DSL se generaron `context.svg`/`context.png` y `containers.svg`/`containers.png`; además, la UI local mostró ambas vistas. | WAR oficial Playwright `structurizr-2026.09.19` / módulo 6.2.3, SHA y URL en `binaries.lock.json`; Java 21 y navegadores Playwright. El repositorio fuente es Apache-2.0; la licencia de cada dependencia empaquetada en la WAR no se auditó completa. Fixture sintético MIT. |
| Structurizr — `fixtures/structurizr/workspace.json` | JSON derivado del DSL; `validate` lo aceptó sin cambiar bytes. Reconoció el mismo modelo y las dos vistas. La UI local cargó la copia de este JSON. | Se conserva el JSON del workspace, incluidos campos de propiedades Structurizr y el DSL original codificado en base64. No es modelo nativo A3. | La UI local mostró contexto/contenedores. Las exportaciones CLI registradas arriba se ejecutaron desde el DSL; no se atribuyen a una exportación CLI directa desde este JSON. | La misma distribución WAR y dependencias de Structurizr; fixture derivado con licencia MIT. El detalle de licencias transitivas de la WAR sigue sin auditar. |

### Mermaid

Dependencias del spike: `mermaid@12.2.0` (MIT), `@mermaid-js/parser@2.0.1` (MIT) y Vite 8.3.4 como servidor local de desarrollo. Los pins exactos están en `experiments/e0/diagram-engines/package-lock.json`. Mermaid exige Node.js 22.12 o posterior según la documentación consultada; el host tenía Node 24.13.1.

El renderizador de Mermaid acepta estos ejemplos, pero la biblioteca de parser publicada por separado no reconoce `c4` ni `class`. Por ello no se debe usar la existencia de SVG o de una API de parse/render como evidencia de que se puede extraer un modelo A3. Para el adaptador candidato: guardar el texto original intacto; solo proponer extracción cuando haya parser y mapeo explícitos por tipo, con diagnóstico de cada propiedad no representada. C4 es experimental según la documentación vigente.

### PlantUML

El binario fijado es el artefacto oficial `plantuml-mit-1.2026.8.jar`, SHA-256 `3629c9cd017c7f73e6450396eea0040216c7e1eef8473ce33cc1aad469dab2f9`, y no una distribución escogida por suposición. El artefacto declara y reporta licencia MIT; este dato no se extiende a otros sabores, paquetes, dependencias o artefactos de PlantUML. La ejecución usa Java y el JAR incluye Graphviz mínimo para el uso probado. No se revisó un inventario completo de licencias de dependencias del JAR.

Los dos formatos de salida se generaron desde un solo archivo de entrada. El SVG es una salida vectorial del renderer; el PNG es una imagen rasterizada. No se comprobó fidelidad editable, extracción de clases ni importación de estilos a A3.

### Structurizr

Se fijó el WAR oficial `structurizr-2026.09.19-playwright.war`, SHA-256 `7b717f14d7dfcbfffa26b9a52d570351375eaea29c8c9b7bd2e0f071a8077d90`, módulo Structurizr 6.2.3 y Java 21. La variante Playwright mide 426,971,336 bytes y necesita navegadores Playwright para sus exportaciones SVG/PNG. La configuración local inicia el servidor en `127.0.0.1`; la UI funcionó para DSL y JSON con los fixtures, sin autenticación. La documentación distingue el comando local gratuito del comando `server`, que requiere licencia.

El repositorio principal de Structurizr publica Apache-2.0, pero no se completó la auditoría de licencias de todas las bibliotecas que lleva empaquetadas esta WAR (incluye, entre otras, dependencias de Spring, Jackson, proveedores de nube y Playwright). Por eso la licencia del repositorio no se declara como licencia única de la distribución empaquetada. No se usó el servicio cloud ni un servidor comercial.

## Reproducción y evidencias

Desde `experiments/e0/diagram-engines/`:

```powershell
npm ci
npm run mermaid:ast
npm run mermaid:serve
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-plantuml.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-structurizr.ps1
```

La página Mermaid se abre en `http://127.0.0.1:4173`. Para probar la UI de Structurizr, el README del spike indica cómo copiar uno de los fixtures a una carpeta nueva dentro de `.cache` y ejecutar el comando `local` en el loopback. Esa UI puede editar, así que debe apuntar únicamente a la copia sintética. Los JAR/WAR, navegadores y datos temporales están bajo `.cache/` (ignorado por Git); el arnés dirige Playwright a `.cache/playwright/`. Durante una primera ejecución exploratoria Playwright llegó a crear navegadores en la caché global del usuario; se identificaron los directorios creados en esa ejecución y se limpiaron. Las ejecuciones reproducibles posteriores usaron exclusivamente la caché local del spike. No se guardaron credenciales ni perfiles de sesión.

Resultados ejecutados en esta máquina:

- `npm ci` instaló 133 paquetes; npm informó 0 vulnerabilidades.
- `npm run mermaid:ast` terminó con `ok: true` y produjo dos diagnósticos explícitos `Unknown diagram type`, mientras verificó los hashes de entrada. El test visual de la página local mostró ambos diagramas renderizados.
- `run-plantuml.ps1` verificó versión, licencia, hashes de fuente y existencia de SVG/PNG; terminó correctamente.
- `run-structurizr.ps1` validó DSL y JSON, comparó el JSON exportado con el fixture (mismo SHA-256), conservó los hashes de fuente y exportó SVG/PNG para ambas vistas; terminó correctamente.
- La UI local de Structurizr se abrió desde copias del DSL y JSON en loopback. No se probó login, cloud ni colaboración.
- No se probaron macOS/Linux, integridad de archivos hostiles, sincronización/undo de A3, ni latencia o escala de diagramas grandes.

Las fuentes oficiales se consultaron el 2026-10-14. La documentación describe comportamiento y requisitos publicados; la tabla anterior distingue lo que se ejecutó en el host. Ninguna afirmación de documentación equivale a una prueba de elegibilidad comercial, cumplimiento de licencia de un paquete transitivo o compatibilidad del producto A3.

| Fuente oficial | Hecho que respalda |
|---|---|
| [Mermaid: Usage](https://mermaid.js.org/config/usage.html) | API `parse`/`render`, salida SVG, `securityLevel` y requisito Node documentado. |
| [Mermaid: C4 diagrams](https://mermaid.js.org/syntax/c4.html) | C4 es experimental y sus capacidades pueden cambiar. |
| [Mermaid: Class diagrams](https://mermaid.js.org/syntax/classDiagram.html) | Sintaxis de clases, campos, métodos y relaciones. |
| [Mermaid npm 12.2.0](https://www.npmjs.com/package/mermaid/v/12.2.0) y [parser npm 2.0.1](https://www.npmjs.com/package/@mermaid-js/parser/v/2.0.1) | Versiones fijadas y licencias de los paquetes publicados. |
| [PlantUML Download](https://plantuml.com/download) y [FAQ](https://plantuml.com/faq) | Sabores/licencias del artefacto, capacidades y condiciones del uso de PlantUML. |
| [PlantUML MIT flavor 1.2026.8](https://github.com/plantuml/plantuml/releases/download/v1.2026.8/plantuml-mit-1.2026.8.jar) | JAR concreto que se descargó, versionó y verificó con `-license`. |
| [Structurizr binaries](https://docs.structurizr.com/binaries), [local](https://docs.structurizr.com/local), [commands](https://docs.structurizr.com/commands), [configuration](https://docs.structurizr.com/local/configuration) y [DSL](https://docs.structurizr.com/dsl) | Versiones, Java 21, modo local, comando de UI/export y diferencia con el comando `server`. |
| [Structurizr source license](https://github.com/structurizr/structurizr/blob/main/LICENSE) y [releases](https://github.com/structurizr/structurizr/releases) | Licencia del repositorio fuente y versión del módulo. No enumeran por sí solas todas las licencias transitivas del WAR usado. |

## Relación con A3-012–017 y decisiones pendientes

- **A3-012:** Structurizr renderizó persona, sistema, contenedor, relaciones y vistas pequeñas. Mermaid C4 también renderizó. La cobertura es parcial: no se probó el mapeo de jerarquías, restricciones o ciclo de vida del modelo nativo A3.
- **A3-013:** Mermaid class y PlantUML mostraron campos, método y multiplicidad. No hubo conversión estructurada a clase/relación A3, por lo que el criterio no queda cubierto.
- **A3-014:** No se probó ninguna notación ni propiedad IoT.
- **A3-015:** Los originales conservaron hashes y los diagnósticos del parser Mermaid evidencian tipos no interpretados por ese parser. Es evidencia parcial sobre preservación y diagnóstico; no hay importador A3 ni cobertura completa de sintaxis desconocida.
- **A3-016:** No se recibió ni probó una referencia visual aprobada; no se declara cubierto.
- **A3-017:** Se generaron SVG/PNG de ejemplos pequeños. No se probaron selección, grupo, dimensiones del workspace, transparencia, fondo, poster de medios ni fidelidad de exportación del producto; no se declara cubierto.

Antes de E0-E quedan abiertas las decisiones sobre subconjuntos admitidos por formato, diagnóstico y edición de construcciones no representables, estructura de datos nativa para relaciones/vistas, e inventario de licencias de WAR y dependencias. La opción segura para el spike es mantener la fuente importada como autoridad y tratar cualquier extracción a datos nativos como conversión explícita y parcial, con reporte de pérdida. No se recomienda fijar estos motores para producción todavía.
