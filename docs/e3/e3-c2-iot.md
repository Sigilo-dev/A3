# E3-C2: redes, validación y exportación IoT

Implementación del modelo de circuito de A3 conforme a `A3_ESPECIFICACION_MAESTRA.md` §§13.4, 15.3 y criterios A3-014/A3-019. Depende del catálogo E3-C1 y de los comandos, revisión, permisos e historial del store E1.

## Identidad y persistencia

Cada componente concreto insertado desde el catálogo sigue siendo una entidad `a3.iot.component` con su ID y puertos persistentes. Una instancia de circuito referencia esa misma entidad por `entityId` y añade su referencia local (`U1`, `MCU1`, etc.) y parámetros de instancia; no copia la definición del componente. El circuito es una entidad `a3.iot.circuit` cuya extensión namespaced `properties["a3.iot.circuit"]` contiene el modelo versionado `1.0.0`. El comando de creación añade una entidad y una representación al workspace; cambiar su modelo pasa por comandos del dominio, el broker, la revisión del store y el historial reversible del canvas.

Las redes ordinarias contienen una lista de extremos `{entityId, portId}` y uniones con IDs y posición opcional. Alimentación y tierra son tipos de red explícitos. Un bus es un grupo lógico con protocolo conocido/desconocido y carriles eléctricos separados; cada carril contiene su propia lista multipunto de pines y uniones. Por eso SDA y SCL de I²C permanecen como redes distintas. Ninguna de estas estructuras se representa mediante `VisualEdge` ni se exporta como una relación binaria E0.

El modelo también conserva parámetros con estado conocido/desconocido, requisitos, restricciones con estado, notas Markdown, preguntas pendientes, notas de red, extensiones namespaced y propuestas de código vinculadas a IDs de red. El validador mantiene los campos desconocidos al reemplazar el modelo y no los evalúa como si fueran datos conocidos.

## Diagnósticos

Las categorías son explícitas:

- `invalid`: referencia a instancia/pin ausente, un pin en más de una red, varias salidas conocidas compartiendo red, tierra y alimentación en corto, voltajes documentados incompatibles o un protocolo incompatible con las funciones de bus documentadas.
- `incomplete`: una red/carril tiene menos de dos extremos, un bus no tiene carriles o los extremos conocidos no muestran una salida. Son advertencias editables, no bloqueos al modelado progresivo.
- `unknown`: límites, protocolo, soporte de bus, señal, parámetro o restricción sin dato documentado. A3 los deja sin evaluar y los exporta como pendientes.

El alcance eléctrico se limita a reglas tipadas para las que el catálogo publica evidencia: dirección, corto conocido entre alimentación/tierra, funciones alternativas de bus documentadas y solapamiento de intervalos de voltaje con unidades reconocidas (`V`/`mV`). No se infiere el pinout de una familia, no se convierte una función alternativa en configuración activa y no se extrapola compatibilidad cuando falta información.

## Inspector y exportación

El inspector permite crear el circuito, incluir componentes del workspace, definir redes multipunto, crear buses y carriles, añadir uniones, parámetros, requisitos, restricciones, notas y preguntas. Distingue visualmente los tres estados de diagnóstico. El servicio guarda las modificaciones como cambios de entidad versionados, revocables mediante undo/redo; conflictos de revisión no sobrescriben una versión más nueva.

El serializador puro `serializeIotCircuitContext` produce:

- `bomCsv`: cantidad por catálogo, fabricante/modelo, referencias e IDs de entidades; referencias rotas aparecen como `unresolved`.
- `connectionsJson`: redes y carriles, cada extremo por ID de entidad y pin, además de buses, uniones y notas.
- `pinTableCsv`: tabla de pines con dirección, señal, buses y redes asociadas.
- `contextMarkdown`: manifiesto explícito de entidades y fuentes, parámetros, requisitos, restricciones, preguntas pendientes, notas, propuestas de código y diagnósticos.

El manifiesto no aplica un tope de tamaño ni trunca el contenido. Si una entidad referenciada no está disponible, se identifica en `omitted` y se conserva su ID como fila no resuelta en BOM; no se la omite en silencio. El inspector permite descargar CSV, JSON y Markdown sin conexión. Las fuentes son las registradas en los componentes del catálogo.

La exportación de contexto es local y determinista. E4 aún no está integrado, por lo que este bloque no invoca proveedores IA ni simula una ejecución, un envío de prompt o una respuesta. El esquema permite conservar código como `proposal`; A3 no lo ejecuta. La edición, validación y exportación no equivalen a simulación eléctrica, comprobación de montaje físico ni certificación.

## Verificación

`fixtures/e3/iot/circuit.json` cubre ESP32 y BME280, dos carriles I²C separados, una red de alimentación y una red de tierra con varios extremos, uniones, parámetro, restricción desconocida, requisito, pregunta y extensiones.

Las pruebas E3-C2 en `packages/domain/test/iot.test.mjs` verifican creación persistente, IDs, carriles y uniones, diagnósticos inválido/incompleto/desconocido, pines inexistentes, uso múltiple, voltajes incompatibles, exportación determinista y manifiesto de fuentes. `packages/project-store/test/iot.test.mjs` verifica escritura mediada por broker, revisión, historial y reapertura. `apps/desktop/test/iot-smoke.cjs` verifica creación en la interfaz, una edición de red incompleta, feedback de diagnóstico, controles de exportación y persistencia tras recargar.
