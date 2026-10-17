# Contrato declarativo de extensiones

Base: especificación local 1.0.0, §24. `package-manifest.schema.json` y `fixtures/e0/declarative-package.json` cubren solo el envelope declarativo E0.

Campos obligatorios: `id` namespaced, `name`, `version` exacta, `license` no vacía, `a3ApiVersion`, `contributes`, `permissions`. E0 añade `schemaVersion` y `extensions`. `license` permite un identificador/expresión o referencia documental; validarla como cadena no acredita derechos de distribución. El fixture declara MIT para sus datos sintéticos.

`contributes` es un mapa namespaced de datos. El fixture usa una contribución opaca `demo.notes` para demostrar conservación; no registra un tipo funcional. En E0 las categorías previstas son temas, nodos, relaciones, prompts, Markdown, lenguajes, validadores, importadores/exportadores, proveedores web/agente y automatizaciones, y sus puntos estaban pendientes. E6-F1 añade un envelope separado con APIs versionadas para tema, Markdown, lenguaje, proveedor y automatización; consulta [versioned extension points](../../e6/extension-points.md). Este envelope no hace funcional una clave E0 desconocida ni interpreta datos como código.

`permissions` es una lista de capacidades solicitadas con namespace, vacía en el fixture. No concede acceso. El catálogo y parámetros de capacidades (raíces, dominios, procesos) requieren ADR; un host debe rechazar o dejar inerte lo que no reconoce. Nuevos permisos por actualización requieren revisión local. `a3ApiVersion` usa una versión exacta en E0, sin afirmar compatibilidad mediante rangos todavía.

Este perfil prohíbe `entrypoints`. Campos desconocidos se conservan como datos inertes: ningún campo, script embebido o ruta se evalúa por superar JSON Schema. Un paquete ejecutable necesitará otro perfil, entrypoints declarados, límites efectivos y API del host. Un worker aislado del hilo principal no demuestra aislamiento de archivos/red.

Abrir un proyecto NO instala ni ejecuta automáticamente paquetes desconocidos. Los declarativos nunca ejecutan código. El lock fija versiones exactas; el registro de instalación conserva origen e integridad/hash. Instalación, actualización y migración son acciones explícitas revisables. Desactivar o desinstalar preserva entidades, propiedades, fuentes y conexiones; se usa fallback genérico.

La API mínima futura expone consultas sobre IDs/revisiones, validación de propuestas y comandos del núcleo bajo capacidades del host; no ofrece Node, filesystem ni ejecución arbitraria al renderer. Las contribuciones de render/export deben informar pérdidas y validar resultados. No se presume compatibilidad binaria con plugins Obsidian. Este bloque no ejecuta extensiones ni prueba el broker de capacidades.
