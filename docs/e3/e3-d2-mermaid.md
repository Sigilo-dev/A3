# E3-D2: conversión del subconjunto Mermaid a modelos A3

Base: E3-D1, commit `ed05c82` en `codex/e3-e7-product`. Fuente normativa: [A3_ESPECIFICACION_MAESTRA.md, §§14.1–14.2 y criterio A3-015](../../A3_ESPECIFICACION_MAESTRA.md); contratos de proyecto y store E1; renderer y licencia fijados en [E3-D1](e3-d1-mermaid.md) y [ADR 0016](../adr/0016-mermaid-source-renderer.md).

## Flujo y garantías

En un nodo `a3.diagram.mermaid@1.0.0`, «Previsualizar conversión a modelo A3» analiza una copia UTF-8 acotada de un recurso `.mmd`/`.mermaid` interno al proyecto. La vista previa presenta familia, claves de origen, IDs A3, elementos a crear/actualizar/sin cambios, sintaxis no convertida, referencias candidatas a recursos ausentes, conflictos de identidad y claves antiguas que ya no aparecen en el archivo. No lee montajes ni URLs y no descarga recursos.

La sintaxis del archivo completo permanece como Resource canónico, sin normalizar finales de línea ni reescribirla. Los IDs generados en la vista previa se guardan en `properties["a3.diagram.import"].mapping`; las entidades y relaciones llevan además el origen Mermaid en `extensions["a3.mermaid.import"]`. Al aplicar, el host relee y valida revisión y SHA-256 de la fuente, valida referencias, permisos `diagram.edit` y `document.edit`, y registra el cambio como un comando reversible del historial común. Una edición externa o cambio de revisión invalida la vista previa. Cada una de las dos acciones finales declara autoridad explícitamente: «conservar autoridad source» o «cambiar autoridad a modelo A3».

Actualizar una importación exige su mapa persistido y siempre crea una vista previa/diff. Los IDs mapeados se conservan aunque cambien títulos. Las claves que desaparecen se reportan como obsoletas; sus documentos no se borran de forma automática, porque pueden tener usos fuera de esa importación. Aplicar reemplaza los campos canónicos importados que aparecen en el diff y conserva extensiones opacas de los documentos existentes. El usuario revisa los cambios antes de aplicar; el editor no ofrece remapeo manual de IDs todavía.

## Gramática comprobada

El adaptador es un parser de líneas independiente de Mermaid. No ejecuta el renderer, directivas, HTML, plugins ni código de la fuente. Los identificadores se comparan sin distinguir mayúsculas: una misma clave con capitalización distinta genera conflicto y bloquea el import. Se ignoran líneas vacías y comentarios `%%` normales.

| Familia | Construcciones convertidas | Representación A3 |
| --- | --- | --- |
| Flowchart | Cabecera exacta `flowchart TB`, `TD`, `BT`, `RL` o `LR`; declaración `ID`, `ID[etiqueta]`, `ID(etiqueta)` o `ID{etiqueta}`; relación dirigida `A --> B` y relación etiquetada `A -- etiqueta --> B`. La etiqueta es texto literal de hasta 200 caracteres. | Concepto/idea y relación conceptual semántica; la vista crea `Placement` y `RelationView`. |
| Class | Cabecera `classDiagram`; declaración `class ID`; atributo `Owner: [visibilidad] nombre: Tipo`; método `Owner: [visibilidad] nombre(param: Tipo, ...): Retorno`; relaciones `--`, `<|--`, `--|>`, `..`, `<|..`, `..|>`, `*--`, `--*`, `o--`, `--o`, `..>` y `<..`, con etiqueta opcional. | Clases UML; atributos/métodos de tipo simple; asociación, generalización, dependencia, composición o agregación. |
| ER | Cabecera `erDiagram`; bloque `TABLE {` con campos `Tipo nombre`, `Tipo nombre PK` y `Tipo nombre UK`; relación con cardinalidades `||`, `o|`, `}|`, `}o`, `|o`, `|{`, `o{`, separador `--` o `..` y etiqueta opcional. | Tabla/entidad ER con campos escalares, PK/UNIQUE, nulabilidad derivada de PK; relación y vista ER con cardinalidad e indicador identificador. |

Los tipos simples son identificadores ASCII con `_.<>[]` y longitud acotada. La visibilidad UML admite `+`, `#`, `-`, `~`. Parámetros de método requieren nombre y tipo. La secuencia, bloques/miembros con otras formas, miembros duplicados, relaciones fuera de la lista, directivas Mermaid, estilos, temas, coordenadas y layout permanecen en la fuente y se reportan cuando la línea no coincide con la gramática. Las formas flowchart redonda/rombo no se convierten como propiedades visuales. FK ER no se convierte: Mermaid no identifica de manera verificable el campo destino. Relaciones/miembros duplicados y referencias con identidad ambigua bloquean la aplicación.

## Límites

- Solo acepta fuente local interna UTF-8 `.mmd` o `.mermaid`; el host no importa desde una carpeta montada ni desde una URL.
- Límite de lectura del host: 1 MiB; parser: 128.000 caracteres y 4.000 líneas; cada línea admite hasta 1.000 caracteres; hasta 500 nodos y 500 relaciones se analizan. La operación se bloquea si el número de documentos que produciría excede el límite reversible común de 1.024.
- «Recursos ausentes» identifica formas candidatas (`href`, `img`, `image`, `icon`) que el parser encuentra en una línea. No es un verificador universal de enlaces o recursos.
- Conversión parcial está permitida: el informe identifica líneas preservadas, pero no intenta reconstruir su apariencia en el modelo A3.
- No se importan PlantUML, Structurizr DSL/JSON, C4, secuencia, estado, gantt u otros diagramas Mermaid. El render Mermaid de E3-D1 y este adaptador son funciones separadas.
- El formato Mermaid no promete que el modelo A3 pueda volver a generar el mismo Mermaid. «Round-trip» comprobado aquí significa serializar/reabrir el modelo A3 y conservar, por separado, los bytes/texto originales del archivo Mermaid.

## Verificación

- `npm test --workspace @a3/domain`: fixtures de flowchart, class, ER, sintaxis negativa, recursos candidatos, conflictos de IDs y referencias no admitidas.
- `node --test test/mermaid-import.test.mjs` desde `packages/project-store`: integración en Windows de los tres modelos nativos, diff inicial/actualización, cambio explícito de autoridad, archivo CRLF intacto, conflicto al cambiar hash y reapertura del proyecto con IDs estables.
- `npm run test:mermaid --workspace @a3/desktop`: renderer y sanitización existente.
- `npm run test:mermaid:smoke --workspace @a3/desktop`: flujo Electron con vista previa, IDs/diff/diagnósticos y ambas opciones explícitas de autoridad.
- `npm run build --workspace @a3/desktop`: tipos host/renderer y build Vite/Electron.

| Criterio | Resultado de E3-D2 |
| --- | --- |
| A3-015 | Parcial y limitado a las tres gramáticas anteriores; fuente preservada, mapping/diff obligatorios para actualizar y diagnósticos por construcciones no convertidas, conflictos y referencias candidatas. PlantUML/Structurizr y conversión universal siguen pendientes. |
