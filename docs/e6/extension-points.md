# E6-F1 — puntos de extensión versionados

Base: A3 §§12.1, 19.1, 24.1 y 24.5; criterios A3-009, A3-026–027 y A3-041–043. El contrato interoperable está en [`versioned-extension-bundle.schema.json`](../../schemas/e6/versioned-extension-bundle.schema.json); la validación semántica pura está en `@a3/domain/extension-points`.

## Contrato de API 1.0.0

Cada contribución declara un ID namespaced, un punto A3, una versión SemVer exacta y un payload JSON. El bundle declara identidad/versión/licencia/autor/origen, dependencias fijadas, permisos solicitados y compatibilidad A3. La compatibilidad con Obsidian queda expresamente `not-asserted`; importar Markdown nunca instala código de plugins Obsidian. `a3ApiVersion` y cada API de punto solo aceptan `1.0.0` para activación; un número futuro se conserva como dato, se informa como incompatible y usa fallback. No se adivina compatibilidad por rango.

| Punto | Payload 1.0.0 | Límites y fallback |
|---|---|---|
| `a3.theme` | Tokens de color, tipografía, tamaño, radio y espaciado con valores restringidos | No CSS, URL ni código. Fallback: tema predeterminado. |
| `a3.markdown` | ID de sintaxis, etiqueta y delimitadores literales | No transformadores ejecutables. Fuente/bloques desconocidos se conservan; fallback: solo fuente. |
| `a3.language` | Alias y reglas léxicas por palabras literales o delimitadores | No regex ni gramática JavaScript/CodeMirror ejecutable. Fallback: texto plano. |
| `a3.provider` | Origen HTTPS exacto, modo, autenticación, coste, permisos pedidos y condiciones | Web manual queda aislada del puente A3; un proveedor de agente es declarado, no ejecutado. Fallback: copiar prompt/manual. |
| `a3.automation` | Disparador y acciones enumeradas | Descripción solamente; motor de automatización de extensiones deshabilitado. Fallback: sin automatización. |

`permissions` documenta solicitudes, no concesiones. Un proveedor no puede elevar el broker del proyecto, heredar cookies, automatizar la página web manual ni convertir un origen en autorización. Los perfiles de paquetes existentes continúan separados; los campos de ejecución prohibidos no se evalúan ni se cargan.

## Registro, conflictos y retiro

El registro de dominio es inmutable por comando y acepta paquetes sin escribir archivos. El mismo ID/versión con el mismo contenido es idempotente; cambiar los bytes de esa versión es conflicto y requiere publicar otra versión. Dos paquetes habilitados que reclaman el mismo ID en el mismo punto dejan ambas contribuciones en estado `conflict`; ninguna gana por orden de instalación. Un punto desconocido queda `unsupported`; una versión distinta queda `incompatible`. Los consumidores reciben fallback y diagnóstico estructurado.

Desactivar marca el paquete inactivo sin quitar su bundle. Retirar deja una marca `retired`; entidades, Markdown y propiedades del proyecto no se editan ni se borran. Para Markdown, el fallback conserva el origen literal. Reactivar o reinstalar el artefacto original puede volver a resolverlo; no se ejecuta migración implícita.

## Evidencia y límites

Pruebas de dominio cubren bundle válido, versión de API futura, colisión determinista, datos de extensión preservados, desactivación/retiro, contenido Markdown intacto, tema inseguro, gramática con regex, permisos de proveedor y rechazo de afirmación automática de compatibilidad Obsidian.

Este bloque aporta el contrato de datos y resolución, no una UI de administrador, catálogo remoto, firmas/autenticidad, verificación legal de licencias, renderizador dinámico de temas/gramáticas, registro de proveedores en WebContentsView ni ejecución de automatizaciones. Los estados `effective` indican admisión declarativa por este registro, no que ya exista una integración visual. Proveedores programados y automatización permanecen deshabilitados mientras E0-C2 no demuestre aislamiento efectivo; A3-043 sigue parcial. A3-009 ya cuenta con sus pruebas de preservación fuente del editor Markdown, mientras A3-026/027 se mantienen en los límites de E5-A1.
