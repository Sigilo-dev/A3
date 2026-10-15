# ADR 0007: montajes locales mediados por el host

Estado: aceptada para E1-E2. Alcance de implementación; no modifica decisiones globales de distribución.

Un documento `Resource.mounted-file` es una solicitud portable formada por mount ID y ruta relativa. El binding efectivo se guarda fuera del proyecto, por proyecto, en el directorio local del host. Una persona debe volver a elegir y aprobar la raíz de un clon. La aprobación queda ligada a ruta canónica e identidad estable del directorio; el lector vuelve a comprobar ambas antes de cada acceso.

Se usa una lectura host-only con `lstat`/`realpath`, identidad de cada segmento, apertura de handle, comparación con `fstat` y revalidación antes y después de leer. Se rechazan los enlaces en el recorrido completo, aunque apunten dentro de la raíz. El acceso no devuelve la ruta absoluta del host. Copiar hacia el proyecto pasa por el writer existente. Referenciar solo escribe el descriptor del proyecto y conserva los bytes externos.

No se implementa borrado externo ni escritura externa. `mount.write` queda marcada como capacidad no disponible incluso después de aprobación de un mount read-write. Esto evita presentar copy-then-delete por ruta como una operación de movimiento segura. La vista previa informa que Move está bloqueado; podrá habilitarse cuando exista y se pruebe una ruta Windows por handle para reparse points.

Consecuencias: la raíz local no viaja con el proyecto; restaurar o clonar requiere una nueva selección. Los archivos externos cambiados o inaccesibles conservan su descriptor y se diagnostican al abrirlos. La mediación protege operaciones que pasan por A3, no a otros procesos del mismo usuario. No se afirma contención de procesos ni protección de energía. La evidencia de E0-C2 mantiene los procesos y la red deshabilitados.
