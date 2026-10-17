# ADR 0026 · operaciones Git locales revisadas

Estado: implementada para E6-A2. Base: E6-A1 `d94c13a`, especificación §22.2/A3-034, contratos E0-A, broker E1-E y recuperación E1-D. Complementa [ADR 0025](0025-local-git-status.md); no cambia esquemas portables ni dependencias.

## Frontera host

`GitProjectController` resuelve exclusivamente el proyecto y sesión activos del manager. IPC acepta acciones tipadas, IDs, selección y texto; nunca acepta raíz, ejecutable, entorno ni argumentos Git. El handler admite solo el frame principal de la ventana local autorizada. La pestaña remota y los agentes no reciben esta API. `LocalGitVersions` serializa operaciones y consume el broker real; no utiliza el autorizador permisivo de los fixtures en producción.

Las capacidades locales `git.status`, `git.diff`, `git.stage`, `git.commit`, `git.branch` y `git.restore` dejan de estar indisponibles globalmente; sus perfiles/concesiones siguen siendo independientes. Proponer requiere aprobación de host al aplicar; Consultar no obtiene escritura por ver un diff. `git.push`, red, shell y procesos arbitrarios siguen indisponibles. Cada aplicación revalida autorización efectiva y sesión. Restore además requiere las capacidades documentales aplicables en el escritor.

## Revisión y aplicación

Cada revisión muestra raíz, rama, archivos y diff, tiene token host de cinco minutos y conserva hashes de índice/archivos y HEAD/rama. Una modificación posterior obliga a revisar de nuevo. No se modifican archivos ni índice al preparar o cancelar. Antes de preparar/aplicar se consulta el veto de borradores de los editores y se rechazan merge/rebase/cherry-pick/bisect y conflictos no resueltos.

Stage/unstage operan sobre archivos explícitos del estado actual, nunca sobre directorios implícitos. Un archivo textual permite escoger hunks del patch generado por Git; no se aceptan patches suministrados por renderer. El índice se prepara en un archivo alternativo bajo `.git`, se comprueban nuevamente las precondiciones y se instala usando un `index.lock` adquirido en exclusiva. Un bloqueo ajeno se conserva. El worktree no cambia.

Commit muestra todo el diff del índice que se publicará, recibe identidad y mensaje explícitos y crea el objeto mediante `write-tree`/`commit-tree`; actualiza la rama original con `update-ref` y comparación del OID previo. Conserva cambios sin stage, no ejecuta hooks, firma, filtros ni helpers. Crear rama requiere revisión explícita, nombre validado y referencia ausente; conserva HEAD y worktree. Se muestran ramas y últimos 30 commits. No hay checkout de otra rama en este bloque.

El runner mantiene el motor/huella/licencia de E6-A1, entorno reducido, argumentos separados, sin shell, 10 s y 8 MiB de salida. Git no se descarga ni se redistribuye. Los paths literales, exclusiones y escaneo de posibles secretos se aplican antes de devolver diffs o preparar commits. Se bloquean archivos protegidos ya trackeados, filtros y punteros LFS; LFS opcional permanece no disponible, sin ejecutar un helper por inferencia. El detector de secretos es conservador y no garantiza descubrir credenciales arbitrarias ni limpiar historia previa.

## Restore recuperable

Solo el proyecto A3 activo admite restore. Se obtienen blobs por OID de commit y path exacto, sin ejecutar `checkout`/`restore` contra el worktree. `prepareVersionRestore` valida identidad, schemas y referencias de todo el conjunto, preserva extensiones e incrementa revisiones. Restaurar una fuente incrementa también su descriptor Resource sin cambiar su ID. Un borrado que deja una referencia viva se rechaza.

El preview usa las imágenes finales del plan, incluidos los metadatos ajustados, y muestra todos los afectados. La aplicación reutiliza el escritor E1, snapshot y journal; el índice Git queda intacto. Cada restore produce un snapshot durable y un token de retorno para otra revisión transaccional. El retorno comprueba los hashes esperados del resultado planificado y no pisa escrituras posteriores. Se conservan hasta ocho retornos en la sesión; después de reiniciar siguen disponibles los snapshots del catálogo E1, no esos tokens de memoria. Las copias locales permanecen en `.a3/local` y están excluidas.

## Límites de concurrencia y durabilidad

El reemplazo de índice y el CAS de una referencia son fronteras distintas. El commit no es una transacción conjunta con el worktree; un objeto sin referencia puede quedar si falla la publicación. Los errores de resultado incierto no se reintentan automáticamente. Se mantiene `index.lock` y se revalida HEAD/rama; no se afirma bloqueo de un proceso hostil que cambie directamente referencias o enlaces en el intervalo de una syscall. Las guardas heredadas de raíces y configuración no son sandbox de kernel.

Restore de varios archivos es una operación lógica recuperable del journal, no atomicidad conjunta ni prueba de tolerancia a corte eléctrico real. No se añaden resolución de merge, checkout, operaciones remotas, escritura de repositorios referenciados, historial de agentes Git ni automatización. Evidencia: [E6-A2](../e6/reviewed-local-version-operations.md).
