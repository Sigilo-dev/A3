# E4-A2 · resolución de referencias y compilación de variables

Implementa el subconjunto de `A3_ESPECIFICACION_MAESTRA.md` §§15.1/15.3 y A3-018/A3-019 que resuelve tokens de variables al mostrar, exportar o previsualizar una plantilla. Depende del formato tipado E4-A1 y usa los permisos de lectura del host.

## Contrato

La sintaxis reconocida es `{{namespace.nombre}}`, con nombres que cumplen el namespace A3. `resolveVariableText(snapshot, source, context, requiredNames)` crea una vista derivada con valores y procedencia; nunca cambia `source`, entidades, recursos Markdown ni VariableSets. Las cadenas interpoladas pueden contener otros tokens y sus ciclos se detectan junto con los ciclos de alias de VariableSet. Hay límites de 64 niveles de resolución, 10 000 referencias, 2 MiB de entrada y 4 MiB de resultado.

String se inserta sin reinterpretar HTML, Markdown, JavaScript o Handlebars. Number y boolean se convierten a su forma textual; list/reference conservan estructura mediante JSON, incluidos IDs estables. Una referencia a objeto sigue siendo un ID y no se busca por nombre o título. No se ejecutan helpers ni expresiones.

Un token ausente, inválido, ambiguo, cíclico o incompatible se reemplaza en la vista por un marcador `[A3: ...]` y entrega diagnóstico con línea/columna cuando existe una ubicación. Los errores que provienen de un valor de variable interpolado se atribuyen al nombre de esa variable. La exportación de Markdown incluye un encabezado explícito con diagnósticos; los exports del lienzo incorporan marcadores visibles y el informe SVG/PDF. El texto original no se sobrescribe.

La interfaz Prompts ofrece previsualizar, copiar o exportar Markdown con selección opcional de workspace/entidad y nombres obligatorios declarados. `canSendAutomatically` es falso si queda un nombre obligatorio sin resolver o existe sintaxis inválida/límite excedido. No existe aún una acción de envío automático que consuma esa autorización; cualquier adaptador futuro debe comprobarla antes de enviar. Un valor opcional sin resolver sigue visible y documentado en el export.

## Integración de lectura

- Los títulos del lienzo y el binding visible `a3.display.label` resuelven tokens solo en el contexto de su workspace y entidad. La entidad y el archivo Markdown mantienen sus valores canónicos.
- El preview del canvas para páginas y texto breve resuelve una copia de Markdown. Abrir el editor sigue leyendo bytes originales. Se muestran diagnósticos en el nodo.
- La exportación SVG/PNG/PDF usa la vista resuelta y adjunta diagnósticos; no modifica la fuente. Las exportaciones de entidad siempre tienen el workspace de su placement. Resolver una entidad sin workspace ante overrides aplicables sigue devolviendo `variable-context-required`.
- IPC de compilación acepta texto Markdown y requiredNames declarativos; solo requiere lectura del proyecto. No permite escritura, rutas, credenciales ni envío a un proveedor.

## Fixtures, pruebas y límites

`fixtures/e4/variables/template-cases.json` cubre tokens simples, valores anidados, nombre faltante, sintaxis no válida y ciclo. Las pruebas del dominio verifican scopes/procedencia, tipos, alias e interpolación cíclica, nombres obligatorios y opcionales, contexto ambiguo, ubicación del error y ausencia de mutación. Las pruebas del store leen un fixture temporal, verifican vista de compilación, preview y SVG, y comparan los bytes Markdown antes/después. El smoke de Electron comprueba el selector de workspace, el preview exportable y el bloqueo ante una variable obligatoria ausente.

Validación observada en Windows: build de dominio/store/desktop y tipos; pruebas dirigidas de dominio, store y exportación; smoke Electron. El aviso ya existente de Vite para chunks mayores de 500 KiB permanece.

El compilador solo sustituye tokens A3 en la vista explícita. Plantillas persistentes, bloques Handlebars/helper, reglas de selección de archivos, manifiesto completo de fuentes, límites de tamaño por contexto, versiones de ejecución y conexión con Codex/otros agentes pertenecen a bloques E4 posteriores. No declara cobertura completa de A3-019 ni envía nada automáticamente.
