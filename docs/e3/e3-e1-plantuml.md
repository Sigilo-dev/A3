# E3-E1: renderer local de PlantUML

## Alcance

A3 registra una fuente PlantUML como entidad `a3.diagram.plantuml` con autoridad `source` y el renderer fijado `plantuml@1.2026.8`. La aplicación muestra el SVG generado y mantiene accesible la fuente completa. Abrir o renderizar el diagrama no reescribe el recurso. Este bloque no convierte la fuente a clases, relaciones ni otros modelos A3, no cambia su autoridad y no pretende admitir una conversión universal.

La interfaz solicita el render por `sessionId`, `workspaceId` y `sourceEntityId`; no envía rutas ni bytes arbitrarios al proceso Java. El host comprueba el workspace, entidad, versión y recurso y vuelve a validar los montajes permitidos. Los archivos remotos no se aceptan como fuente PlantUML. Los errores de sintaxis, motor ausente, runtime ausente, límites superados y cambios de acceso dejan la fuente intacta.

## Motor y licencias

El artefacto es el JAR oficial `plantuml-mit-1.2026.8.jar`, SHA-256 `3629c9cd017c7f73e6450396eea0040216c7e1eef8473ce33cc1aad469dab2f9`. El proceso de preparación y las pruebas vuelven a verificar el hash. PlantUML `-license` confirma MIT para ese artefacto. El JAR declara que también empaqueta GraphViz mínimo, OpenIconic, recursos de Archi, bibliotecas de sprites, ASCIIMathML, Brotli y otros recursos; el inventario y la licencia de cada dependencia empaquetada no se han auditado completamente. La licencia MIT del JAR no se extiende por inferencia a cada componente que contiene.

El artefacto se obtiene únicamente durante preparación de desarrollo, pruebas o build, desde el release fijado de GitHub; el descargador limita tiempo y tamaño, valida hosts de redirección y comprueba el hash. En el primer render, el host copia el JAR verificado a su caché local. No se descargan binarios al abrir un proyecto ni se instala Java globalmente. La máquina necesita Java 21 o posterior; sin él, A3 conserva la fuente y muestra el diagnóstico. En el host de E0 se verificó Eclipse Temurin/OpenJDK 21.0.10. Java no se incluye en este paquete y su distribución conserva su propia licencia GPLv2 con Classpath Exception.

## Lectura segura y límites efectivos

El servicio obtiene la raíz del proyecto y solo añade una raíz de montaje si el broker local concede lectura y la raíz sigue disponible. El renderer comprueba las raíces canónicas y que la carpeta de la fuente permanezca dentro de una de ellas. La expansión de includes locales admite rutas literales que resuelven dentro de esas raíces; comprueba identidad del archivo al abrir y al leer para detectar sustitución concurrente. Se admiten hasta 32 directivas, profundidad 8, 256 KiB por archivo incluido y 2 MiB acumulados. `!include` respeta include una vez; `!include_many` permite repetirlo; repetir una ruta con `!include_once` devuelve error. Un include ausente, dinámico, cíclico, remoto, UNC o externo produce diagnóstico y no inicia Java. Se rechazan también `%load_json` y `%file_exists`. `!includesub` y selección de subdiagramas dentro de un include no están soportados por esta expansión y se diagnostican; la fuente original permanece disponible. Los recursos de la biblioteca estándar escritos como `!include <...>` se resuelven desde el propio JAR.

El proceso Java recibe la fuente expandida por `stdin`, usa un directorio temporal vacío como `cwd`, no hereda `JAVA_TOOL_OPTIONS`, no ejecuta mediante shell y corre con perfil PlantUML `ALLOWLIST` sin rutas ni URLs autorizadas en el hijo. Así, los includes de usuario que el host ya validó se suministran como texto y el motor no necesita abrirlos. `!includeurl` y `%load_json` se rechazan antes del proceso. Un test de red local verifica que una URL de `!includeurl` no llega al servidor.

Límites del proceso: 12 segundos por render, heap Java de 256 MiB, metaspace de 128 MiB, máximo de 2 procesadores, tamaño PlantUML de 4096 unidades, SVG de salida hasta 8 MiB y stderr hasta 1 MiB. La aplicación sanea el SVG con DOMPurify y retira referencias y contenido activo antes de mostrarlo.

Esto es un proceso auxiliar acotado; **no es una sandbox del sistema operativo**. Java conserva la identidad y los permisos del usuario de Windows. Las restricciones descritas aplican al perfil y al lenguaje de PlantUML y no sustituyen AppContainer, un token restringido ni un firewall. No afirmamos resistencia a una vulnerabilidad del JAR/JVM ni a corte eléctrico. Las reglas de acceso pueden seguir evolucionando tras pruebas específicas.

## Evidencia y criterios

`npm run test:plantuml --workspace @a3/desktop` prepara el artefacto fijado y prueba SHA-256/licencia MIT, Java 21+, render del fixture, ausencia de modificación de fuente, motor/runtime ausente, include fuera de raíces, include local anidado, URL sin conexión, error de sintaxis, timeout, memoria/tamaño y límite de includes. Los fixtures están en `fixtures/e3/plantuml/`.

- **A3-015:** parcial. La fuente se mantiene y hay diagnóstico de error, pero no existe conversión ni informe de elementos mapeados.
- **A3-016:** parcial. Hay render local con versión fijada; falta una referencia visual aprobada y comparación de estilos, por lo que no se declara aceptado.
- **A3-013:** no se cubre aquí la edición UML estructurada ni el round-trip entre notaciones.

No se probó Windows AppContainer, macOS, Linux, cada familia de diagramas PlantUML, todos los recursos estándar, una matriz de fuentes, ni un inventario legal completo de componentes del JAR.

## Fuentes oficiales consultadas

- [Guía de seguridad de PlantUML](https://plantuml.com/security)
- [Opciones de línea de comandos de PlantUML](https://plantuml.com/command-line)
- [Release PlantUML MIT 1.2026.8](https://github.com/plantuml/plantuml/releases/tag/v1.2026.8)
- [FAQ oficial de Temurin y licencia de OpenJDK](https://adoptium.net/docs/faq)
