# ADR 0029 · Git limitado a repositorios montados

Estado: implementada para E6-C2. Base: E1-E2 resolución de mounts, E6-A1/A2 Git local, especificación §§18.2 y 22.2–22.3, criterio A3-036. No cambia datos portables ni agrega dependencias.

## Binding y capacidades locales

Cada `mountId` de un recurso `mounted-file` se resuelve mediante el binding local del host. La raíz y su identidad física viven en `.a3/local/bindings.json`; el proyecto versionado solo conserva el mount ID y las rutas relativas. Un clone no hereda un binding. Un binding movido o ausente sigue visible y puede relocalizarse con una selección nativa de carpeta; no se presenta como archivo vacío.

El host registra por mount las concesiones independientes `index`, `read`, `write` y `git`. Lectura se concede al aprobar una raíz elegida por la persona; indexación y Git empiezan denegados y requieren aprobación local. Las operaciones además necesitan la capacidad general del perfil del proyecto. Revocar una concesión se comprueba en la siguiente operación, incluso al aplicar una revisión Git ya preparada. E0-C2 no demostró un límite seguro para escribir en carpetas externas, por lo que `write` permanece siempre falso; copiar/referenciar siguen siendo acciones distintas del store E1.

## Operaciones Git

La pestaña Git permite elegir explícitamente Proyecto A3 o una raíz montada autorizada. Cada vista muestra la raíz y rama que devolvió ese repositorio. La acción «Git de esta raíz» desde el montaje del explorador abre la pestaña con su mount ID; el renderer nunca envía una ruta ni un ejecutable. El host vuelve a resolver binding, estado, identidad y concesión Git para cada load, revisión, aplicación o cancelación. No busca repositorios padres, hermanos ni el repositorio de la carpeta contenedora.

Los servicios mantienen identidad y revisión independientes por mount. Stage, commit y creación de rama afectan solo al repositorio seleccionado y conservan el flujo de diff revisado de E6-A2. Restore de archivos externos y publicación GitHub no se ofrecen para mounts. La raíz A3 conserva sus controles existentes. El Git configurado dentro del montaje sigue sujeto a las restricciones, exclusiones y verificaciones del adaptador E6-A1/A2.

## Evidencia y límites

La prueba integrada A3-036 crea dos repositorios en carpetas con espacios/Unicode, con ramas `main` y `develop`; carga ambas ramas, stagea y commitea únicamente en el montaje seleccionado, comprueba que el HEAD y bytes del otro repositorio quedan intactos y revoca Git para comprobar que la siguiente lectura se deniega mientras el otro mount sigue accesible. Las pruebas del store comprueban las concesiones independientes y la revocación inmediata.

No hay transacción conjunta entre el proyecto A3 y archivos Git externos, ni edición/restauración de sus bytes desde A3. Mounts sin un recurso `mounted-file` no aparecen en este selector Git. La prueba usa Git local verificado en fixtures temporales; no demuestra garantías de pérdida eléctrica ni aislamiento del sistema operativo más allá de las verificaciones existentes de E1/E6.
