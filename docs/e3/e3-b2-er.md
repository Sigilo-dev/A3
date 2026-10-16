# E3-B2: semántica de diagramas entidad–relación

Base: E3-B1 UML aceptado en `codex/e3-e7-product`. Fuente: especificación §§6, 13.3 y criterios A3-004, A3-005, A3-013, A3-033, A3-047 y A3-048. Decisión: [ADR 0015](../adr/0015-er-native-model.md).

## Entrega

ER se modela como familia nativa independiente de UML. Las tablas usan Entities `a3.er.table`; cada campo persiste con UUID, nombre, tipo textual, nullable, PK, FK y UNIQUE. Los enlaces FK contienen `tableId` y `fieldId`; cambiar el título de la tabla o renombrar el campo no altera esos destinos. Una FK solo puede apuntar a un campo PK o UNIQUE conocido.

Las relaciones ER usan Relations `a3.er.relationship` con etiqueta, cardinalidad en ambos extremos e indicador de relación identificadora. RelationViews guardan la representación por workspace. Una relación técnica no se convierte en línea visual ni se exporta como UML. Las mismas tablas pueden mostrarse en varios workspaces con placements y posiciones distintos.

El inspector permite crear/reutilizar tablas, editar título/descripción, agregar/editar/quitar campos, seleccionar FKs existentes y crear/reutilizar/editar relaciones. Todas las escrituras pasan por el servicio del host con revisión y permiso `diagram.edit`. El lienzo dibuja una tarjeta de tabla y una arista ER con sus cardinalidades; el inspector copia el export Mermaid ER del modelo compatible.

## Compatibilidad y validaciones

El modelo valida IDs de campo duplicados, PK nullable, destino FK faltante/no único/no PK, extremos no ER y estructura/cardinalidad de relaciones. Los ciclos de relaciones no se prohíben; ER permite, por ejemplo, relaciones recursivas cuando el modelo lo requiere. El duplicado de contenido remapea IDs de tablas y relaciones internas; los UUID de campos permanecen locales a la tabla y se conservan.

El exportador Mermaid ER acepta identificadores ASCII, tipos acotados a la gramática segura implementada y etiquetas sin sintaxis de inyección. Muestra los títulos mediante aliases cuando son seguros; identificadores incluyen UUID completo y comentarios guardan los IDs A3 estables. Incluye PK/FK/UK, nulabilidad mediante comentarios de atributo, cardinalidad e identificación. Si algo sale del subconjunto, el export se bloquea con diagnósticos. No se importa Mermaid todavía, no se produce SQL ni se garantiza compatibilidad con dialectos. Tipos/versiones futuras quedan intactos y fuera de la proyección especializada; el fallback genérico sigue mostrando las propiedades.

UNIQUE se limita a una columna; aún no hay restricciones únicas compuestas ni claves foráneas compuestas. Los tipos son texto sin validación de dialecto. Este bloque no implementa edición de secuencia, estado o actividad.

## Criterios

| Criterio | Cobertura en E3-B2 | Límite |
|---|---|---|
| A3-013 | Campos, tipos, nulabilidad, claves PK/FK/UNIQUE, cardinalidad y export Mermaid ER del subconjunto. | Parcial; sin importación bidireccional ni export SQL. |
| A3-004 / A3-006 | Misma Entity entre workspaces, Placement independiente y RelationView por workspace. | No vuelve a cubrir todos los comportamientos del canvas. |
| A3-005 | Duplicación remapea tabla/relación interna y FK interno; no duplica relaciones externas por defecto. | Sin remapeo de tuplas de campos porque FK es de una columna. |
| A3-033 / A3-047 | Escritura mediante el broker/store; revisión obsoleta rechazada y bytes de Markdown sin cambios. | No añade capacidades, recuperación ni aislamiento nuevos. |
| A3-048 | Extensiones opacas sobreviven a cierre/reapertura; tipo futuro queda fuera de renderer/proyección ER. | No es migración ni reparación automática. |

## Fixtures y verificación

`fixtures/e3/er/scenario.json` incluye Cliente y Pedido, PK, UNIQUE, nullable, FK y relación uno a cero-o-muchos. `resolve.mjs` traduce claves del fixture a IDs antes de aplicar comandos.

Pruebas dirigidas:

- `node --test packages/domain/test/er.test.mjs`: familia separada, renombres, segunda vista, FK/cardinalidad, rechazos, ciclos, export seguro, fallback futuro, extensiones y duplicación interna.
- `node --test packages/project-store/test/er.test.mjs`: store temporal en Windows, edición, cierre/reapertura, workspace compartido, extensiones externas, conflicto de revisión y bytes no relacionados sin cambios.
- `npm run test:er --workspace @a3/desktop`: smoke Electron con edición UI de tablas/campos/PK/FK/relación, render de arista y export Mermaid cargado desde el host.
