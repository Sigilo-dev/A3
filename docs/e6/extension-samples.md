# E6-F2 — paquetes de muestra y compatibilidad

Este catálogo fija los ejemplos reproducibles de E6 y su alcance real. Los archivos fuente están en [`fixtures/e6/extensions/`](../../fixtures/e6/extensions/). Cada muestra declara versión exacta `1.0.0`, licencia `MIT` y, donde aplica, API A3 `1.0.0`. Esos son metadatos del fixture: A3 valida la forma de la declaración, pero no realiza una auditoría legal de la licencia ni autentica al autor.

## Matriz

| Ejemplo | Artefacto y API | Capacidad solicitada | Compatibilidad que se probó | Fallback / límite |
|---|---|---|---|---|
| Tema `Paper` | `community-samples.json`, `a3.theme@1.0.0` | Ninguna | JSON Schema, validador de dominio y registro declarativo | Tema predeterminado; tokens no son CSS y aún no los aplica una UI de temas. |
| Sintaxis Markdown `:::note` | `community-samples.json`, `a3.markdown@1.0.0` | Ninguna | Delimitadores literales aceptados; `unknownSource: preserve` | Solo fuente; bloques desconocidos permanecen intactos. No instala plugins de Obsidian. |
| Lenguaje `A3 Flow` | `community-samples.json`, `a3.language@1.0.0` | Ninguna | Alias, palabras literales y comentario declarativo | Texto plano. No contiene regex, parser, JavaScript ni gramática ejecutable de CodeMirror. |
| Gemini manual | `community-samples.json`, `a3.provider@1.0.0` | Solicita `web.manual-navigation` | Origen HTTPS, modo manual, sesión iniciada por la persona; registro deja la contribución como `declared-only` | Copiar prompt/abrir manualmente. El paquete no inicia sesión, lee ni controla la página. Disponibilidad y coste dependen del plan, región y condiciones vigentes; A3 no determina que sea gratis. |
| Claude manual | `community-samples.json`, `a3.provider@1.0.0` | Solicita `web.manual-navigation` | Mismas restricciones manuales que Gemini; no se automatiza una conversación | Copiar prompt/abrir manualmente; sin puente A3 ni lectura de página. Coste y disponibilidad no especificados por el fixture. |
| Vista previa de prompt | `community-samples.json`, `a3.automation@1.0.0` | Ninguna | Disparador manual y único paso enumerado `prompt.compile` | `no-automation`: el registro declara datos solamente y no ejecuta acciones. |
| Tipo C4 `Service` | `c4-service-node.json`, paquete de nodos `1.0.0` / API `1.0.0` | Ninguna | Instala en proyecto limpio; categoría C4 se resuelve porque el tipo declara `extensions["a3.c4.category"] = "component"`; se probó en dos entidades | Fallback genérico conserva datos y conexiones al retirar el paquete. No crea por sí solo el campo semántico `a3.c4` de cada instancia. |
| Referencia IoT BME280 | `iot-bme280-reference.json`, paquete de nodos `1.0.0` / API `1.0.0` | Ninguna | Instala/exporta/reimporta como tarjeta de referencia con fabricante, modelo, fuente y revisión desconocida | Es un tipo comunitario de referencia, no `a3.iot.component`; su puerto es lógico, no un pin. No aporta pinout, límites eléctricos, simulación ni certificación. La revisión de documento indicada por la fuente no demuestra revisión del silicio. |

`a3.provider` se declara como navegación manual, con los orígenes exactos `https://gemini.google.com` y `https://claude.ai`; el registro de extensiones mantiene estos aportes inactivos (`declared-only`) porque no existe aún un instalador/runtime de proveedor desde paquetes. La concesión solicitada en el manifiesto no otorga permiso efectivo. Si una futura integración registra esos destinos en la vista web manual de E5-A1, debe seguir aplicando el aislamiento por origen y la sesión del usuario de ese flujo; eso no forma parte de estos fixtures.

## Instalar, exportar y retirar

Los paquetes de tipo de nodo C4 e IoT son artefactos JSON `a3.node-types`: importa un archivo, revisa nombre, versión, licencia declarada, API, IDs, hash y destino; confirma explícitamente la licencia y deja que el host lo guarde mediante el store transaccional. Exportar produce JSON canónico portable. La prueba E6-F2 instala ambas muestras en un proyecto temporal limpio, exporta sus bytes canónicos, valida el round-trip y los importa en un segundo proyecto limpio.

Retirar marca el paquete `removed` en el lock local y conserva el artefacto. Las pruebas comparan los bytes de las entidades y relaciones antes y después: IDs, propiedades, puertos y extremos se mantienen intactos. El registro deja de ofrecer los tipos, por lo que A3 presenta el fallback genérico; volver a instalar el mismo artefacto revisado vuelve a registrar su representación. El contrato de instalación requiere `document.edit`; no reclama `package.install`.

El bundle `community-samples.json` sí se valida, registra, resuelve y retira en las pruebas puras de dominio. El registro de extensiones versionadas aún no tiene instalador persistente por proyecto ni UI de catálogo; por eso no se presenta como un paquete que ya se pueda instalar desde una pantalla de A3. Su ciclo probado es la API de registro: al retirarlo, se conserva íntegro dentro del registro y cada consumidor recibe su fallback.

## Evidencia consolidada de E6

| Bloque | Evidencia y estado |
|---|---|
| E6-D1/D2, A3-041/042 | El builder y el importador validan tipos/campos/puertos, manifiesto, IDs, hash, licencia declarada y lock. Las pruebas cubren instalación revisada, reapertura, importación portable, duplicados, rollback de escritura, fallback y retirada/reinstalación sin reescribir entidades o relaciones. |
| E6-E1/E2, A3-043 | Se validan permisos declarados, perfiles, lifecycle, desactivación y retiro lógico; datos ejecutables no se cargan. El host de código de extensiones permanece **deshabilitado** porque E0-C2 no aceptó aislamiento real de procesos en Windows. Revocar un registro no demuestra detener un proceso arbitrario. A3-043 sigue parcial. |
| E6-F1/F2 | APIs de puntos fijadas en `1.0.0`; pruebas de tema, Markdown, lenguaje, proveedores manuales declarados, automatización inerte y fallbacks; muestras de nodos se importan/exportan en proyectos limpios. |

No se prueban ni se afirman firmas/autenticidad del autor, auditoría legal de licencias, descarga de un catálogo remoto, actualización de paquetes ejecutables, ejecución de extensiones, integración visual de todos los puntos, editor/host de idiomas extensible, registro de proveedores desde extensiones ni automatización. Ninguna prueba implica compatibilidad de plugins de Obsidian. La especificación A3 §24.5 exige un adaptador específico probado; importar Markdown no instala código de otra aplicación.

## Pruebas

- `packages/domain/test/e6-sample-packs.test.mjs` valida el bundle y nodos de muestra, resoluciones seguras, categoría C4 explícita y ausencia de semántica eléctrica canónica en la tarjeta IoT.
- `packages/project-store/test/extension-sample-packs.test.mjs` instala, exporta, reimporta y retira paquetes con proyectos temporales en Windows, comprobando conservación byte por byte de entidades y relaciones.
- [`extension-points.md`](extension-points.md), [`node-packages.md`](node-packages.md), [`node-package-installation.md`](node-package-installation.md), [`extension-host.md`](extension-host.md) y [`extension-lifecycle.md`](extension-lifecycle.md) detallan los contratos de cada capa.

La matriz cubre la porción validada de A3-041/042 y registra el estado parcial de A3-043; no marca toda la aceptación de E6 como completa.
