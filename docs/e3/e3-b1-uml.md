# E3-B1: semántica de diagramas UML de clases

Base aceptada: E3-A2 `c12a08c`, rama `codex/e3-e7-product`. Especificación §§6, 13.3 y 14.2; envelopes de E0-A y servicios E1/E2 existentes. Contrato y decisiones: [ADR 0014](../adr/0014-uml-class-semantics.md).

## Entrega y subconjunto

Se incorporan clases, interfaces, enumeraciones y paquetes. El inspector del lienzo permite crear, editar y reutilizar entidades; seleccionar un paquete semántico; editar descripción, visibilidad, abstracción, estereotipos y restricciones; añadir/editar/quitar atributos, métodos, parámetros ordenados y literales de enum. Tipos textuales y referencias de tipo por UUID permanecen separados. No se infieren relaciones a partir de nombres o tipos.

Se incorporan asociación, dependencia, generalización, realización, agregación y composición como Relation + RelationView. El inspector edita etiqueta, roles, multiplicidades, navegabilidad, estereotipos y restricciones, y permite representar una relación existente en otra vista. Las tarjetas muestran compartimentos, firmas, visibilidad, estáticos subrayados y abstracción en cursiva. Las conexiones distinguen triángulos de herencia/realización, dependencia discontinua y diamantes de agregación/composición.

El mismo Entity ID mantiene contenido único; cada Placement conserva su geometría. Editar un clasificador actualiza las otras vistas; mover una representación no cambia sus otras posiciones. El broker, revisiones, escritor Windows, journal y undo/redo son los existentes, sin ruta de escritura privilegiada desde React. Las propiedades opacas se preservan al editar y persistir, incluidas las anidadas en miembros y tipos. No se agregan dependencias, motores ni actualizaciones del lockfile.

Reglas verificadas: pertenencia a paquete existente sin ciclos; IDs de miembros únicos en el clasificador; tipos por ID hacia clasificadores UML existentes; límites de multiplicidad válidos; relaciones entre familias compatibles; generalización acíclica clase→clase/interfaz→interfaz; realización clase→interfaz; composición con máximo un todo por parte. Se admiten ciclos de asociación/dependencia. La contención semántica no utiliza Groups y no reorganiza el lienzo automáticamente.

## Criterios y evidencia

Fixture: [scenario.json](../../fixtures/e3/uml/scenario.json), con paquete, clase abstracta, interfaz, enum, atributos, método, parámetros, referencias de tipo y los seis tipos de relación con roles/multiplicidades. [resolve.mjs](../../fixtures/e3/uml/resolve.mjs) resuelve exclusivamente las claves simbólicas del fixture a IDs antes de enviar comandos.

| Criterio | Cobertura de este bloque | Límite |
|---|---|---|
| A3-013 | Subconjunto UML de clases y firmas, seis relaciones, roles/multiplicidades y persistencia. | Parcial: ER es otra familia; conversión/exportación aún pendiente. |
| A3-004 / A3-006 | Entidad compartida entre dos workspaces, geometría independiente, RelationView separada de VisualEdge. | No se vuelve a declarar cubierto todo canvas. |
| A3-005 | Duplicación remapea padres, tipos de atributos/parámetros y relaciones internas; no duplica la herencia externa. | Los UUID de miembros están acotados a su clasificador. |
| A3-033 / A3-047 | Revocación del broker y revisiones obsoletas rechazan escrituras; se conservan los bytes previos. | No añade procesos, comandos arbitrarios ni agentes nuevos. |
| A3-048 | Campos desconocidos anidados, bytes sin editar y tipos futuros preservados; diagnóstico de propiedades inválidas. | No es una nueva implementación de recuperación ni prueba de corte eléctrico. |
| A3-052 | Formularios etiquetados, selección de referencias y botones de orden sin requerir gestos de arrastre. | Sin auditoría completa de accesibilidad o rendimiento. |

Comprobaciones reproducibles:

- `npm run build`: tipos de dominio/store/main/renderer y compilación Electron/Vite.
- `npm test`: contratos E0, invariantes y comandos de dominio, store temporal Windows, coordenadas y lenguajes existentes.
- `npm run test:uml --workspace @a3/desktop`: Electron con perfil/proyecto temporal; cuatro tipos, paquete, atributo y referencia de tipo, visibilidad, firma y parámetro, literal de enum, realización, edición de rol, compartimentos y conexión nativa.
- `npm run test:c4 --workspace @a3/desktop`: regresión del inspector/render común C4.

Las pruebas de store crean los seis tipos de relación; cierran/reabren; representan entidades y relaciones en otro workspace; preservan extensiones añadidas por un productor externo durante cierre; verifican undo/redo, revisión obsoleta, revocación y que el Markdown previo conserve sus bytes. Los fixtures se copian a carpetas temporales; no se usan proyectos del usuario.

Resultado local observado (Windows, 2026-10-16): `npm test` aprobó 288/288 (34 contratos, 82 dominio, 162 store, 6 viewport y 4 lenguajes), sin omisiones. Build y tipos aprobaron; los smokes Electron UML y C4 aprobaron. Tras ajustar la resolución de UUIDs en la UI sin distinguir mayúsculas, se repitieron build/tipos y smoke UML con resultado satisfactorio. `git diff --check` no detectó errores de whitespace.

## Frontera de compatibilidad

No se presentan secuencia, estados o actividad como modelos visuales estructurados. Este bloque tampoco implementa ER, importadores PlantUML/Mermaid, renderizado de motores originales, cambio de autoridad source/model, generación de código o exportación SVG/PNG/PDF. La matriz de §14.2 sigue pendiente de sus adaptadores; disponer de semántica nativa no acredita fidelidad de conversión/exportación.

El subconjunto no incluye clases de asociación, asociaciones n-arias, calificadores, templates, perfiles ejecutables, resolución de sobrecarga ni miembros heredados calculados. Restricciones y valores iniciales son texto inerte. Los paquetes se representan como tarjetas con referencias semánticas, no como un editor automático de diagramación anidada. Tipos personalizados o versiones desconocidas usan el fallback existente; no se adivina una categoría UML.
