# E4-B1 · plantillas Markdown con bloques seguros

Implementa el modelo, parser y compilador puro del subconjunto de A3 §15.2. Amplía E4-A2 y la compilación de variables sin escribir documentos de proyecto ni enviar prompts.

## Documento de plantilla

Una plantilla portable es Markdown UTF-8 con un encabezado JSON dentro del comentario `<!-- a3-template/1 ... -->`. El metadato declara versión, ID namespaced estable, nombre, objetivo, entradas tipadas, variables obligatorias, reglas descriptivas para seleccionar contexto, formato de salida, descripción Markdown y extensiones namespaced. El cuerpo es Markdown y se analiza como texto.

El parser valida la versión/campos y conserva propiedades de metadatos desconocidas al volver a serializar. Un encabezado inválido o una plantilla de tamaño no soportado entrega diagnóstico; nunca se transforma en una plantilla vacía que se pueda guardar encima.

## Gramática implementada

Es una gramática Handlebars pequeña y compatible en sintaxis; no se usa Handlebars.js ni se generan/evalúan funciones JavaScript.

```handlebars
{{proyecto.nombre}}                   {{! referencia A3 resuelta por E4-A2 }}
{{input.objetivo}}                    {{! entrada declarada de la plantilla }}
{{upper input.actor}}                 {{! helper A3 registrado }}
{{#if input.opcional}}texto{{else}}alternativa{{/if}}
{{#each input.items}}- {{@index}}: {{this}}{{/each}}
```

Los helpers incorporados son `upper`, `lower`, `join`, `json`, `default`, `eq` y `not`. El registro solo acepta operaciones declarativas de esa lista; una extensión puede añadir un alias a una operación permitida cuando el host la autorice, pero no registra una función arbitraria. `if`, `each`, `else` y cierres son directivas de bloque.

Se rechazan helpers no registrados, triple mustache, rutas no declaradas, acceso a `constructor`/`prototype`, subexpresiones, whitespace control, bloques desconocidos, argumentos complejos y cierres mal formados. Se imponen límites de tamaño (plantilla 2 MiB, entradas 128 KiB, salida 4 MiB), 10 000 tokens/iteraciones y 16 bloques anidados. Un error bloquea uso automático y conserva la fuente en una exportación diagnóstica.

Las entradas de usuario se interpolan una vez y no se vuelven a procesar como expresiones ni como variables A3. Las referencias A3 del cuerpo sí se resuelven en el contexto explícito de proyecto/workspace/entidad mediante E4-A2; el resultado es una vista y no muta documentos o variables. Las variables obligatorias ausentes bloquean el uso automático y siguen exportables con marcas explícitas.

## Ejemplos y límites del bloque

El catálogo incluye historia de usuario, revisión de texto, checklist, propuesta IoT y resumen de proyecto. Sus entradas, objetivo y reglas de contexto se muestran en el panel Prompts. E4-B2 añade selección explícita de entidades, requisitos, criterios, memoria, recursos textuales y relaciones semánticas; sus límites y garantías están en [prompt-context.md](prompt-context.md). Las reglas de la plantilla siguen siendo sugerencias: no activan selección automática ni amplían contexto por líneas visuales.

El panel permite editar el cuerpo del ejemplo durante la sesión, previsualizar, copiar o exportar el Markdown. La edición de una plantilla como documento persistente, versiones de plantilla, permisos de paquetes externos y registro de extensiones no forman parte de E4-B1. La gramática de plantilla no ejecuta código ni lee archivos; la compilación de contexto E4-B2 lee solo fuentes elegidas a través del host y guarda trazas locales de hashes. Ningún bloque envía prompts a un agente. El texto resultante es Markdown sin ejecutar HTML/JavaScript; la sanitización de cualquier renderizador posterior sigue siendo obligatoria.

## Evidencia y criterios

`fixtures/e4/prompts/template-cases.json` contiene plantillas válidas y casos de helper no registrado, expresión con apariencia JavaScript, bloque incompleto y JSON inválido. `packages/domain/test/prompt-templates.test.mjs` cubre parse/serialización, los cinco ejemplos, helpers permitidos, bloques, variables, datos de entrada no re-interpretados, diagnósticos localizados y bloqueo de salida automática. `packages/project-store/test/variables.test.mjs` comprueba compilación del fixture dentro de una sesión real de proyecto bajo lectura del broker y que el Markdown/JSON de variables no se reescriben.

Relación: A3-018 conserva resolución tipada de variables (E4-A1/A2); A3-019 obtiene plantillas compilables y previsualizables sin conexión. E4-B1 cubre el formato y la gramática, mientras que E4-B2 cubre contexto explícito y manifiesto trazable. A3-019 sigue parcial: falta persistencia/versionado de plantillas y flujos de agente.
