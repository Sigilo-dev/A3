# ADR 0014: semántica nativa de diagramas UML de clases

Fecha: 2026-10-16. Alcance: E3-B1, especificación §§6, 13.3 y 14.2; base aceptada E3-A2 `c12a08c`, contratos E0-A, dominio, escritor, broker e historial E1/E2.

## Identidades y autoridad

Los cuatro tipos incorporados son `a3.uml.class`, `a3.uml.interface`, `a3.uml.enum` y `a3.uml.package`, versión exacta `1.0.0`. Son documentos `Entity` del contrato existente: UUID, revisión, `title`, `tags`, `properties`, `ports`, `bindings` y `extensions`. Las firmas UML viven en `properties["a3.uml"]`. El modelo A3 nativo es su única autoridad editable; no se crea una fuente PlantUML/Mermaid paralela ni se cambia una fuente importada.

`Placement` conserva únicamente posición, tamaño y estilo por workspace. `Relation` conserva extremos por Entity ID; `RelationView` conserva sus representaciones por Placement ID. El mismo clasificador y la misma relación pueden aparecer en varios workspaces sin duplicarse. Una línea `VisualEdge`, un grupo espacial y una colección lógica no crean herencia, pertenencia a paquete ni asociación.

## Propiedades de entidad

| Campo | Contrato versión 1 |
|---|---|
| `description` | Markdown textual; no ejecuta HTML. |
| `visibility` | `public`, `protected`, `private`, `package`; símbolos `+`, `#`, `-`, `~`. |
| `abstract` | Booleano de clasificador; un paquete no es abstracto. |
| `stereotypes`, `constraints` | Listas de texto legibles, sin evaluación de perfiles ni OCL. |
| `parentId` | UUID opcional de un paquete del proyecto, sin ciclos de contención. No es un Group. |
| `attributes` | Lista ordenada de `{id,name,type,visibility,static,readOnly,defaultValue}`. |
| `methods` | Lista ordenada de `{id,name,returnType,visibility,static,abstract,parameters}`. Son firmas; no ejecutan código. |
| `literals` | Solo para enum: lista ordenada de `{id,name,value}`. |

Un tipo es `{name,entityId?}`: nombre textual libre (incluidos tipos externos o genéricos) y referencia opcional a un clasificador UML compatible del proyecto. La referencia resuelve por ID, nunca por el nombre mostrado. El renderer usa el título actual del clasificador referenciado. Los tipos textuales no se convierten implícitamente en entidades o asociaciones.

Cada parámetro guarda `{id,name,type,direction,defaultValue}`, con dirección `in`, `out` o `inout`. El retorno usa `returnType`. Valores iniciales, tipos y restricciones son texto; no hay parser de lenguaje ni evaluador. Las identidades UUID de atributos, métodos, literales y parámetros son únicas **dentro de su entidad**, estables al editar y locales a ese clasificador. No son documentos E0 adicionales ni IDs globales del proyecto.

Paquetes contienen clasificadores u otros paquetes por referencia; no tienen atributos, métodos ni literales. Enumeraciones pueden tener firmas además de literales. El subconjunto no aplica generación de código ni todas las reglas normativas UML: no calcula miembros heredados, resolución de sobrecarga, redefinición, perfiles, templates o restricciones ejecutables.

## Relaciones

Tipos incorporados exactos `a3.uml.{association,dependency,generalization,realization,aggregation,composition}@1.0.0`. Se almacenan en el envelope Relation E0 con `properties["a3.uml"]`:

```json
{
  "label": "contiene",
  "source": {"role": "pedido", "multiplicity": {"lower": 0, "upper": 1}, "navigable": false},
  "target": {"role": "lineas", "multiplicity": {"lower": 1, "upper": "*"}, "navigable": true},
  "stereotypes": [],
  "constraints": ["total >= 0"]
}
```

Los límites son enteros seguros no negativos; el superior es un entero mayor o igual al inferior, o `*`. Los metadatos de ambos extremos se conservan para todos los tipos; la navegabilidad se dibuja como flecha donde corresponde a asociación/agregación/composición, independientemente de la convención de extremos del registro del dominio.

| Tipo | Convención y validación del subconjunto |
|---|---|
| Asociación | Clasificador → clasificador; admite autorrelación y ciclos. |
| Dependencia | Elemento → elemento, incluidos paquetes; admite ciclos. |
| Generalización | Subtipo → supertipo: clase→clase o interfaz→interfaz. Admite varios padres, sin ciclos ni autorrelación. |
| Realización | Clase implementadora → interfaz, sin autorrelación. |
| Agregación | Clase que representa el todo → clasificador parte. Diamante hueco en origen. |
| Composición | Clase que representa el todo → clasificador parte. Diamante sólido en origen; el extremo del todo tiene máximo 1. |

No hay puertos UML en estas relaciones. Una asociación no constituye una conexión C4, ER o eléctrica. Las multiplicidades de asociaciones entre clasificadores no son el número permitido de documentos Relation: esa cardinalidad de incidencias del registro E0 es un concepto distinto. No se valida un grafo de instancias ni un ciclo de vida de objetos.

## Escritura y compatibilidad

El comando público tipado `a3.uml.change` permite crear/editar/reutilizar elementos y relaciones. El host genera IDs, exige revisiones actuales, aplica el broker (`diagram.edit` y capacidades derivadas de los documentos modificados), y usa el escritor/journal y el historial común. Las firmas son datos canónicos; no se persiste estado React Flow. No se añade un historial paralelo ni una operación nueva de borrado global entre workspaces.

Los campos desconocidos de documentos, propiedades, miembros, parámetros, tipos y extremos sobreviven a ediciones de campos conocidos. Los arrays se editan por IDs; quitar explícitamente un miembro quita ese miembro con sus extensiones. Duplicar contenido remapea referencias internas a paquetes/tipos/relaciones; mantiene las referencias externas y no duplica relaciones externas por defecto. Duplicar representación conserva Entity ID.

Una versión no soportada queda en fallback, con bytes y propiedades intactos, y no puede editarse con este comando. Un documento conocido malformado genera diagnóstico localizado; no se completa con datos inventados. El renderer solo interpreta datos compatibles y trata todo texto como contenido, sin HTML ejecutable.

El alcance de UML se contrasta con [UML 2.5.1 de OMG](https://www.omg.org/spec/UML/2.5.1/About-UML) y la [documentación oficial de clases de PlantUML](https://plantuml.com/class-diagram), consultadas el 2026-10-16. Este ADR define un formato A3 nativo, no declara compatibilidad completa con esos motores. La conversión de código y exportación de §14.2 corresponden a adaptadores posteriores con fixtures propios.
