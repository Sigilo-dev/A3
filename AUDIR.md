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
