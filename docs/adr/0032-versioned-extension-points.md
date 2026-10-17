# ADR 0032 — contratos versionados de puntos de extensión

Estado: aceptada para el registro declarativo E6-F1. Base: A3 §§12.1, 19.1, 24.1, 24.4–24.5; E0 de extensiones; ADR 0031.

## Decisión

A3 define cinco puntos con API exacta `1.0.0`: `a3.theme`, `a3.markdown`, `a3.language`, `a3.provider` y `a3.automation`. Los tres primeros aceptan payloads de datos con validación acotada. La UI de tema o editor solo debe consumir esos datos mediante código del host ya instalado. El punto de proveedor distingue navegación web manual de proveedor de agente. Automatización y agente pueden declarar metadatos y permisos pedidos, pero no adquieren un runtime.

El bundle declara origen, autor, versión, licencia, dependencias, API A3, permisos solicitados y compatibilidad Obsidian `not-asserted`. La procedencia local conserva solo un nombre visible; no guarda rutas absolutas. Un catálogo solo acepta un origen HTTPS sin ruta ni credenciales. La licencia es texto declarado, no prueba de derechos.

## Compatibilidad y fallback

La activación exige igualdad exacta de versión de API; no hay rangos hasta que una evolución compatible se pruebe. Versiones incompatibles y puntos desconocidos conservan el bundle y producen fallback. Un ID repetido en el mismo punto vuelve conflictivas todas las reclamaciones habilitadas; el host no escoge la primera.

La gramática de lenguaje usa literales/delimitadores, nunca regex o módulos CodeMirror externos. Los reconocedores Markdown describen delimitadores y exigen conservar fuente desconocida. Los temas usan tokens limitados y rechazan CSS. Orígenes y permisos declarados por proveedor no se convierten en concesiones ni en acceso al puente A3. Los paquetes Obsidian no se aceptan como compatibles automáticamente.

Desactivar y retirar son comandos de registro que preservan bytes de paquete y datos del proyecto. El fallback de Markdown es vista de fuente; el de lenguaje es texto plano; los demás puntos tienen fallback explícito en la tabla del contrato E6-F1.

## Consecuencias

La resolución vive en el dominio puro y no requiere React ni filesystem. El schema JSON describe el envelope; validación semántica adicional fija límites por punto. La instalación, visualización de estado, UI de conflictos y persistencia del registro quedan para un bloque posterior. No se afirma ejecución segura de plugins. E0-C2 sigue bloqueando providers programados y automatizaciones de extensión; A3-043 permanece parcial.
