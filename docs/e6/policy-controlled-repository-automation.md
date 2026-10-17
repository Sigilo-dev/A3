# E6-C3 · automatización Git controlada por política

Base: rama `codex/e3-e7-product`, E6-C2 aceptado; origin `https://github.com/Sigilo-dev/A3.git`. Fuente: especificación §§21/22.3–22.4, ADR 0006, ADR 0026–0029 y criterio A3-037. Decisión: [ADR 0030](../adr/0030-policy-controlled-git-automation.md).

## Comportamiento

La política empieza en manual. Para cada proyecto o montaje Git la persona elige los archivos exactos, rama, plantilla del mensaje y espera. La espera inicial es cinco minutos. La plantilla solo resuelve `date`, `branch`, `files` y `count`; no ejecuta Handlebars, JavaScript ni comandos. La pantalla permite previsualizar el diff, muestra estado, rama, permisos efectivos y diffs de los commits automáticos.

El commit se bloquea si el permiso directo de stage o commit falta, el buffer A3 está sucio, la rama cambió, el repo no está listo, hay conflicto/merge/rebase, existen archivos staged fuera de la selección, los bytes cambiaron desde revisión, o las validaciones Git existentes rechazan contenido/rutas. Los permisos directos se consultan nuevamente al ejecutar y aplicar cada etapa.

Push automático está apagado por defecto y requiere activar una opción independiente, el permiso directo y revocable `git.push`, una credencial protegida disponible y una URL GitHub exacta. Está disponible solo para el repositorio raíz de A3; en mounts se deshabilita. Antes del commit revisa cuenta, repositorio y rama remota. Si el destino cambió o su rama diverge del historial local, se detiene sin crear el commit. El transporte usa la raíz y OID aprobados; no hace force push, no publica tags y no cambia `origin`.

Los archivos de política y ejecución están en `userData/git-automation`, identificados por un hash local de proyecto/raíz/mount. No se copian dentro del proyecto, no se versionan y no guardan tokens ni rutas. El token continúa cifrado por Windows DPAPI en el vault E6-B1. Al revocar una capacidad el host cancela el transporte activo y el próximo paso vuelve a consultar el broker.

Un marcador de ejecución se escribe antes de stage. El mensaje de commit incluye un ID idempotente; si A3 reinicia después del update-ref, reconoce ese mismo commit por ID. Los push fallidos dejan un OID pendiente; «Reintentar solo este push pendiente» comprueba que HEAD y rama siguen iguales y reenvía solo ese commit. La capacidad revocada o autorización vencida detiene el envío. Un fallo de red tras comenzar el push puede tener resultado remoto incierto, así que no se reintenta sin acción visible.

## Validación

Ejecutado en Windows, con fixtures sintéticos. El nuevo grupo de pruebas cubre A3-037: denegación de push sin stage/commit, conflicto local sin mutation, rama remota divergente sin stage, token expirado antes del commit, espera configurable, diff devuelto, recuperación por ID tras interrupción y push pendiente con el mismo OID sin crear un segundo commit. El suite Git usa además el adaptador Git verificado en directorios temporales.

```text
npm run typecheck --workspace @a3/desktop
npm run build --workspace @a3/desktop
npm run test:git --workspace @a3/desktop
npm run test:github --workspace @a3/desktop
git diff --check
```

Resultado observado: build/tipos aprobados, **35/35 pruebas Git y 11/11 pruebas de publicación GitHub**, sin skips; `git diff --check` limpio. Las pruebas de API GitHub usan fixtures; no se usaron cuentas, tokens o repositorios reales ni se ejecutó un push externo. No se ejecutan scripts del proyecto automatizado: el host solo invoca el binario Git comprobado y operaciones de argumentos cerrados.

**A3-037, evidencia parcial y delimitada:** política por repositorio, commit automático de archivos explícitos y push automático opcional quedan conectados al broker; los casos principales de denegación, conflicto, auth, recuperación y retry están probados. No se declara publicación de extremo a extremo con GitHub real ni cobertura de resultados inciertos de red. El scheduler requiere que la pestaña Git esté activa; reiniciar inicia de nuevo el período de espera. No hay fetch/pull/merge automático, auto-resolución, OAuth GitHub, push de montajes, LFS ni `force`.
