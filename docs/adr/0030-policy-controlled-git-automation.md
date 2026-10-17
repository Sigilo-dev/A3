# ADR 0030: automatización Git controlada por política

Estado: aceptada para E6-C3. Fecha: 2026-10-17.

## Contexto

La automatización por repositorio puede crear commits y, si la persona lo activa, publicarlos. A3 ya tiene commits locales revisados (ADR 0026), publicación GitHub explícita y vault protegido (ADR 0027), broker de capacidades (ADR 0006), y bindings de montajes (ADR 0029). La regla portable del proyecto no puede conceder capacidades locales.

## Decisión

- La política predeterminada es manual. La persona puede activar un commit tras cinco minutos de inactividad, cambiar la espera, elegir rama, seleccionar explícitamente hasta 128 archivos y configurar una plantilla de mensaje con placeholders fijos (`date`, `branch`, `files`, `count`). No se evalúa código de plantilla.
- La política y el marcador de ejecución se guardan en `userData` del host, bajo una clave derivada de proyecto, raíz e identidad observada. No contienen rutas absolutas, tokens ni secretos. Clonar un proyecto en otra raíz no copia la política.
- Commit automático exige permisos efectivos `git.stage` y `git.commit` en modo directo, raíz disponible, rama activa igual a la configurada, buffer A3 guardado, selección exacta, índice sin cambios ajenos, sin conflictos/merge/rebase, y validaciones de seguridad del servicio Git existente.
- Push automático requiere una segunda opción visible (`pushAfterCommit`), capacidad `git.push` efectiva en modo directo, cuenta/token presente en el vault Windows protegido y URL GitHub HTTPS exacta configurada. Se limita al proyecto A3 raíz; los repositorios montados pueden automatizar commits locales si tienen capacidad Git, nunca push desde esta función.
- Antes del commit, la publicación revalida cuenta, destino, permiso, rama local y rama remota. Si existe la rama remota, su commit debe ser ancestro del HEAD local observado. Una divergencia detiene el lote antes de stage/commit. El envío usa el pack de la historia verificada y refspec explícito sin force.
- Un ID idempotente queda en el mensaje del commit y el estado `committing` se persiste antes de stage. Tras reinicio, A3 reconoce un commit ya creado por ese ID y no duplica el commit. Un push pendiente conserva el OID exacto; el reintento explícito nunca vuelve a crear el commit.
- Conflicto, rama distinta, permiso revocado, auth expirada o destino no verificable detienen el lote. Revocaciones cancelan transportes activos y cada operación local vuelve a pasar por el broker. Sin permiso directo no se abre una aprobación implícita desde el scheduler.
- Solo se usan comandos Git del adaptador host con argumentos cerrados y binario verificado. No se ejecutan hooks o scripts del repositorio. El push de staging usa `--no-verify`; el commit local usa `commit-tree`.

## Consecuencias y límites

El scheduler funciona mientras la pestaña Git está activa; si la aplicación estaba cerrada durante la inactividad, el primer ciclo inicia la espera otra vez. El diff se puede previsualizar antes de activar la política y se conserva en el resultado de cada commit automático. El modelo no hace `fetch`, `pull`, merge ni resolución automática. Si un push se interrumpe tras comenzar el transporte, el resultado puede ser incierto; A3 lo deja detenido y permite revisar/reintentar solo el mismo OID. Una carrera remota posterior a la última comprobación todavía puede causar rechazo remoto. No se promete atomicidad distribuida entre Git local y GitHub ni durabilidad frente a corte eléctrico.

## Verificación

E6-C3 prueba denegación separada de `git.push`, conflicto local/remoto, autorización vencida antes del commit, espera, diff visible, recuperación idempotente y reintento de push del mismo OID con mocks. Las pruebas existentes de Git verifican el adaptador real y los comandos permitidos. No se realizó un push real a una cuenta GitHub.
