# Contrato de dominio E0-A

Base: especificación maestra local 1.0.0, §§4, 6–8, 10, 13–15, 24, 28 y 30. Este contrato publica el subconjunto inicial comprobable; no implementa A3. Los nombres de campos que no figuran en los ejemplos de la especificación son propuestas E0 para fixtures, pendientes de ratificación antes de E1.

## Objetos e identidades

| Objeto | Identidad y referencias | Autoridad y revisión |
|---|---|---|
| Project | `projectId` UUID; `defaultWorkspaceId`; `catalogRoot` relativo | Manifiesto `a3.project.json`, `formatVersion`, revisión del manifiesto, no contador global del proyecto. |
| Workspace | `id` UUID; carpeta `.a3/workspaces/<id>/` | `workspace.json` contiene nombre, viewport y propiedades; sus hijos son documentos separados. |
| Entity | `id` UUID; `type` namespaced + `typeVersion`; `contentResourceId` opcional | Propiedades JSON, puertos y bindings; el texto canónico reside en Resource. |
| Resource | `id` UUID; ubicación discriminada por `kind` | `project-file`: `path`; `mounted-file`: `mountId` + `path`; `remote-url`: `url`. Nunca combinaciones de esas ubicaciones. Revisión del descriptor, no del contenido binario/textual. |
| Relation | `id` UUID; tipo/version; `source` y `target` con `entityId` y `portId` opcional | Semántica del modelo, independiente de que exista una vista. Cada puerto se resuelve dentro de su entidad. |
| Placement | `id` UUID, `entityId`; workspace determinado por carpeta | Posición, tamaño y estilo propios. No guarda una segunda copia editable del contenido. |
| VisualEdge | `id` UUID; `sourcePlacementId`, `targetPlacementId` | Solo organización visual dentro del workspace. No crea Relation, dependencias, contexto de IA ni conexiones eléctricas. |
| RelationView | `id` UUID, `relationId` y dos placements locales | Dibuja Relation; sus placements deben representar los extremos correspondientes. Puntos de paso y estilo pertenecen a esta vista. |
| Group | UUID local al workspace; miembros por placement, drawing o subgrupo | Organización espacial, sin ciclos; no equivale a contención C4. Documento revisado independiente. Esquema pendiente. |
| Collection | UUID de proyecto, miembros por `entityId` | Organización lógica reutilizable entre vistas, sin duplicar contenido. Documento revisado independiente. Esquema pendiente. |
| NodeType | Nombre namespaced + versión exacta | Define campos, bindings permitidos, conectores, reglas y mapeo técnico explícito. Pertenece a un paquete; no tiene que ser una entidad. Esquema detallado pendiente. |
| Variable | Nombre namespaced + alcance y propietario | Valor o expresión, tipada; proyecto, workspace, entidad o ejecución. Revisión del documento contenedor para persistidas. Las temporales no se persisten por inferencia. |
| DiagramDocument | Identidad de Entity + Resource fuente | Metadatos de motor, versión y perfil; autoridad `source` o `a3-model`. Cambio explícito con preview; no se promete round-trip universal. Metadatos detallados pendientes. |

Los UUID no dependen de título o ruta. Los IDs de puerto son cadenas estables locales a su entidad; renombrar su etiqueta no cambia su ID. El patrón UUID comprueba representación hexadecimal, no aleatoriedad, versión de generación ni unicidad global. El ámbito exacto de unicidad entre categorías queda pendiente; los fixtures usan IDs globalmente distintos.

Las entidades se descubren por el catálogo del manifiesto: `.a3/entities/<id>.json`, `resources/<id>.json`, `relations/<id>.json`. En cada workspace: `workspace.json`, `placements/<id>.json`, `visual-edges/<id>.json`, `relation-views/<id>.json`. El nombre de archivo debe corresponder al ID. No se serializa el estado de React Flow.

## Serialización y referencias

JSON estricto UTF-8, indentación de dos espacios, salto LF final y orden de claves determinista. E0 adopta orden de inserción estable para los fixtures; el orden canónico de un escritor general queda pendiente. No hay comentarios, números no finitos ni binarios base64 en campos de dominio. Los ejemplos nuevos de Markdown usan UTF-8/LF; recursos importados deben conservar bytes cuando no cambian.

`formatVersion: 1.0.0` identifica el manifiesto; `schemaVersion: 1.0.0` los documentos del subconjunto. `revision` empieza en 1 en E0 y crece por documento confirmado, hasta el entero seguro de JavaScript. Restaurar contenido es un cambio nuevo; no debe reutilizar una revisión obsoleta. Una edición de texto también requiere precondición sobre sus bytes/hash: la revisión del descriptor Resource no basta.

Los objetos admiten campos desconocidos para poder conservarlos. `properties`, `bindings`, `style`, `extensions` y `contributes` son mapas con claves namespaced, por ejemplo `demo.notes`; sus valores aún no se interpretan sin el contrato del paquete. Se conservan sin otorgarles permisos ni ejecutarlos. El perfil E0 usa segmentos ASCII en minúsculas separados por punto; no pretende fijar toda futura gramática de nombres.

Los esquemas validan estructura con JSON Schema 2020-12. Sus `$id` son identificadores lógicos, no endpoints publicados ni URLs que el validador deba descargar. Referencias entre archivos, puertos, igualdad de IDs, unicidad y compatibilidad de tipos requieren una segunda validación. Los campos desconocidos no están certificados por superar el esquema.

Las rutas portables son relativas con `/`, sin segmentos `.`/`..`, unidades, barras invertidas ni separadores vacíos. El esquema no demuestra existencia ni contención real; el host futuro debe resolver symlinks/junctions, raíces y permisos. El formato `absolute-url` comprueba URL absoluta, no permiso para abrirla ni protocolo seguro. La activación requiere política del host.

## Invariantes

1. Renombrar o mover conserva identidad. Crear otra representación conserva Entity y crea Placement; duplicar contenido crea nuevos IDs y remapea relaciones internas. Relaciones externas solo se duplican por elección explícita.
2. Editar contenido afecta todas las representaciones; mover una cambia solo su documento de vista. Quitar un placement no borra Entity ni Resource.
3. Un RelationView debe resolver Relation y placements del mismo workspace; VisualEdge nunca sustituye a Relation.
4. Tipos de relación declaran dirección, extremos, cardinalidades y reglas. `a3.core.references` es el nombre provisional E0 de `references`. Este spike comprueba existencia, no validez técnica C4/UML/ER/IoT.
5. Relaciones con extremos ausentes se conservan como diagnósticos reparables. Un fixture candidato inválido falla la prueba; un lector real no debe borrar el archivo ni impedir abrir entidades sanas.
6. Grupos no tienen ciclos. Collections no son grupos. Una red IoT no queda definida por el par de extremos del esquema Relation E0.
7. Variables: ejecución > entidad > workspace > proyecto; exportar sin contexto no elige workspace arbitrariamente. Detectar ciclos, nombres inexistentes y tipos incompatibles; nunca almacenar credenciales como variables.
8. Conservar campos desconocidos, fuente original y datos de paquetes ausentes. Desactivar/desinstalar permite fallback genérico sin eliminar contenido.
9. Ninguna propuesta, importación o paquete amplía concesiones efectivas; no se guardan secretos en Git, exports ni logs.
10. No declarar completada una operación fallida ni ocultar pérdidas detectadas al exportar. Cambios masivos requieren recuperación y resolución de conflictos; un error localizado no inutiliza todo el proyecto.

## Decisiones abiertas para ADR posterior

| Tema | Alternativas que requieren decisión |
|---|---|
| Unicidad y referencia de documentos | UUID global en proyecto o clave `(categoría, id)`; Group ya tiene ámbito local. |
| Revisión del contenido | Documento de versión/hash separado o actualización coordinada del descriptor Resource. No confundir hash con autorización. |
| Relación no dirigida y cardinalidades | Extremos ordenados con tipo declarando simetría, o endpoints con roles; no inferir dirección técnica de `source`/`target`. |
| IoT | Entidad Network con participantes o relación n-aria especializada; no imponer aristas binarias a toda red. |
| Versiones y nombres | Rangos SemVer en compatibilidad vs versión exacta; gramática completa, prereleases y aliases. E0 solo ejercita versiones exactas básicas. |
| Variables y bindings | AST declarativo tipado o expresión restringida; direccionamiento por campo y serialización de referencias explícitas. |
| Grupos, colecciones y tipos | Referencias con discriminador o listas separadas; reglas de pertenencia múltiple, esquemas de campos/puertos y exportadores. |
| Esquemas restantes | Group, Variable, Mount, Policy y definiciones completas de NodeType/DiagramDocument antes de sus módulos; no quedan cubiertos por los esquemas actuales. |
| Preservación | Parches sobre árbol parseado o representación con tokens para conservar formato; rechazar escritura insegura ante versión no soportada. |

Tensión documentada: la orden inicial de bootstrap pedía publicar especificación/prompts, pero la instrucción expresa del usuario prohíbe hacerlo. Se mantienen locales, excluidos de Git; no se modifica la fuente maestra. No se identificó una contradicción de dominio que autorice cambiar sus decisiones cerradas.
