# ADR 0013: modelo C4 compartido y documentos de vista nativos

Fecha: 2026-10-16. Alcance: E3-A2, especificación §§6, 13.2 y 14.2; contratos E0-A y separación Entity/Placement de E1/E2.

## Decisión

Los elementos C4 son `Entity` de versión exacta `1.0.0`: `a3.c4.person`, `software-system`, `container`, `component`, `boundary`, `deployment-node` e `instance`. Nombre y etiquetas usan `title` y `tags`; `properties["a3.c4"]` guarda descripción Markdown, tecnología, URL, condición externa y referencias `parentId`, `instanceOfId` y `environment` cuando corresponden. No hay una copia de estas propiedades en cada representación.

La contención es una referencia canónica de hijo a padre. Sistema → contenedor → componente admite límites intermedios transparentes al nivel estructural. Un nodo de despliegue puede contener nodos del mismo entorno e instancias de sistemas/contenedores. Los ciclos de contención, categorías incompatibles, referencias ausentes y entornos incompatibles producen diagnósticos. `Group` nunca modifica estas referencias.

Una relación semántica usa `a3.c4.relationship@1.0.0`, extremos por Entity ID y descripción/protocolo en `properties["a3.c4"]`. Sus representaciones son `RelationView`. No se generan relaciones implícitas, de contención ni de instancia al dibujar una `VisualEdge`.

Una vista nativa es un documento Entity `a3.c4.diagram@1.0.0` con autoridad explícita `properties["a3.diagram.authority"] = "a3-model"`. Su único modelo editable vive en `properties["a3.c4.view"]`: versión, familia, workspace, ámbito, entorno y pasos. El workspace referencia el documento mediante `properties["a3.c4.diagram-id"]`. Cada vista tiene un workspace; los `Placement` y `RelationView` existentes conservan geometría independiente por vista. Las vistas nativas no necesitan un Resource con una segunda serialización del modelo. Un importador futuro adjuntará el Resource de fuente original según §14.1, sin convertirlo en una segunda autoridad editable. Una autoridad `source` o versión de vista desconocida no se cambia por estos comandos.

Una vista dinámica guarda pasos con UUID propio, `order` positivo y único, `relationViewId` y descripción opcional. El orden no depende de la enumeración de archivos, de React Flow ni de la posición de los nodos. Puede repetirse una relación mediante pasos diferentes; ordenar/quitar un paso no modifica la relación compartida.

Los tipos personalizados declaran `NodeType.extensions["a3.c4.category"]` con una categoría soportada en una definición versionada del registro del host. No se deduce una categoría del nombre o de propiedades importadas de la entidad. Ausencia del paquete/versión conserva los datos y referencias en fallback. Iconos y estilos adicionales permanecen como datos; este ADR no instala paquetes.

## Escritura y recuperación

Los comandos `a3.c4.change` se preparan y confirman mediante el broker, las revisiones, el escritor, snapshots y journal existentes. Crear vista escribe documento de diagrama y manifiesto del nuevo workspace en la misma operación lógica de varios archivos.

El escritor reconoce durante staging exclusivamente el diagnóstico `file-missing` del manifiesto de workspace que su plan está creando. La comprobación final exige catálogo completo, sin errores y con todas las identidades previstas. Los directorios de workspace previamente ausentes se registran en la extensión del journal `a3.store.created-workspace-directories`; rollback elimina únicamente esos directorios si están vacíos, mediante `rmdir` no recursivo. Si aparecen contenidos externos, los conserva y bloquea con conflicto. No se modifica la lectura normal para ocultar manifiestos ausentes.

Las ediciones de datos y vistas usan el historial común. Deshacer la creación del workspace permanece deshabilitado: el store aún deniega la eliminación de carpetas de workspace, y no se presenta como una acción disponible. Esta limitación no afecta a la persistencia ni a la recuperación de su creación.

## Compatibilidad

La distinción entre elementos, vistas, despliegue e interacciones explícitas se contrasta con la [referencia oficial de Structurizr](https://docs.structurizr.com/dsl/language) y su [vista dinámica](https://docs.structurizr.com/dsl/cookbook/dynamic-view/), consultadas el 2026-10-16. El formato de almacenamiento aquí descrito es A3 nativo. La conversión de DSL/workspace JSON y la fidelidad de exportación corresponden a los adaptadores E3-E/E3-F, no se deducen de disponer de un modelo C4.
