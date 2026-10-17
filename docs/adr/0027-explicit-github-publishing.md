# ADR 0027 · publicación explícita en GitHub

Estado: implementada para E6-B1. Base: E6-A2 `e395bfb`; especificación §§22.1, 22.2, 22.4/A3-035, contratos E0-A y límites E0-C2. Complementa ADR 0025/0026 sin cambiar el formato portable ni agregar dependencias.

## Cuenta y API

No existe registro OAuth de GitHub/client ID configurado para A3. La interfaz lo declara y ofrece dos acciones manuales: conectar un token personal o abrir `https://github.com/new` para usar herramientas Git externas. No se reutilizan cookies del chat, la cuenta ChatGPT ni la autorización Codex; tampoco se finge un login OAuth.

La importación del token requiere diálogo nativo explícito. Solo el host lee el portapapeles después de la confirmación, valida la cuenta con `GET /user` y guarda el token en `userData/github-authorization/credentials.bin`, cifrado mediante `safeStorage`/DPAPI en Windows. No hay campo de token, retorno ni secreto en renderer, proyecto, log o configuración Git. Las mutaciones de credenciales se serializan con desconexión/revocación. Se limpia el portapapeles actual si sigue conteniendo el token importado; no se controla el historial independiente de Windows. Desconectar elimina la credencial local y cancela envíos; no revoca el token en GitHub ni la sesión del navegador. Sin almacén protegido no hay fallback en texto y queda el flujo externo.

La API usa exclusivamente `https://api.github.com`, versión fijada `2026-03-10`, headers oficiales, rutas construidas en host, sin redirección, 15 s y cuerpo de 1 MiB. Solo existen `GET /user`, `GET /repos/{owner}/{repo}` y `POST /user/repos`. Las respuestas se reducen a IDs, login, nombre, visibilidad y permiso; ni cuerpos de error ni headers de autorización llegan a diagnósticos. El token personal necesita permisos aplicables: metadatos y escritura de contenidos para publicar; creación/administración para crear. No se presume que un token válido supere las reglas de rama, workflows u organización.

## Proyecto, revisión y permisos

`GithubProjectController` comparte el binding y origen IPC de confianza del host. Renderer no determina raíz, cuenta autenticada ni ejecutable. Solo opera sobre la sesión y raíz del proyecto A3 activo, en modo escritor sin cambios pendientes/conflicto. El proyecto local no requiere remote. No se escribe `origin`, no se reemplaza configuración ni se infiere un remoto desde un clone. Un destino existente se elige escribiendo su URL HTTPS; cada envío conserva su destino explícito, sin asociarlo a otro proyecto ni a un montaje.

`git.push` se habilita únicamente para este transporte cerrado GitHub, manteniendo concesión efectiva del broker y aprobación por perfil. `network.access`, shell, procesos y apps genéricas siguen indisponibles; tener un token no concede capacidades A3. No se registra herramienta de agente ni se acepta un push por copiar un prompt. La revocación, cambio de proyecto y cierre cancelan solicitudes pendientes/en curso cuando es posible.

La revisión muestra raíz, cuenta e ID, URL canónica, ID remoto, visibilidad, rama destino, OID del commit, archivos/tamaños y exclusiones. Se valida que la API devuelve exactamente ese repositorio y permiso de push. El perfil inicial de creación es privado. Un destino existente debe coincidir con la visibilidad elegida; A3 no la cambia. Crear solo admite la cuenta personal autenticada y crea vacío (`auto_init:false`); no sube archivos. El push siempre exige otra revisión.

La confirmación final exige repetir la URL exacta y aceptar un diálogo nativo con destino y cuenta, además del broker. Tokens host de revisión: cinco minutos, una aplicación, máximo ocho. Antes del envío se releen cuenta, repositorio/ID, visibilidad, permiso, sesión, raíz, credencial y commit/rama fuente. Cambiar alguno invalida la revisión; no se reintenta una operación incierta automáticamente.

## Historia y transporte Git

Push envía historia, no solo el árbol actual. Se inspeccionan todos los objetos alcanzables desde el OID seleccionado, incluidos archivos borrados en commits anteriores. Se verifica el hash de cada objeto y se recorren los árboles de todos los commits: rutas protegidas, symlinks/gitlinks, posible secreto o puntero LFS bloquean el envío. No se filtra ni reescribe la historia automáticamente. El detector de secretos es conservador, puede rechazar código legítimo y no garantiza encontrar cualquier credencial. Las exclusiones heredadas incluyen `.a3/local`, caché, dependencias y claves. Los montajes externos no se incorporan por inferencia. Otras ramas/tags y archivos sin commit no se envían.

Se genera un pack completo del OID revisado y se importa mediante `unpack-objects --strict` en un bare temporal vacío creado con `--template=`. Antes de usarlo se comprueba identidad de raíz y hash de configuración generada; no se copia configuración, remotos ni hooks del proyecto. El transporte usa el Git nativo fijado en E6-A1 y el helper HTTPS de esa instalación comprobado por SHA-256. Token: header HTTP por entorno privado del proceso, no argumento ni archivo. Entorno no hereda proxies/SSH/GIT_*; helper de credenciales y hooks desactivados, HTTPS único, TLS verificado, proxy vacío, redirecciones desactivadas, sin recurse-submodules, tags ni force.

El refspec contiene el OID exacto y `refs/heads/{rama}` explícita; un non-fast-forward o regla remota se rechaza por Git, sin fallback forzado. El proyecto original no cambia índice, archivos, remote ni rama. El staging se limpia al finalizar normalmente. Los temporales pueden quedar tras caída del proceso; no contienen el token en configuración. Presupuesto de historia: 5 000 objetos, 8 MiB por objeto, 64 MiB de salida/pack y 50 000 visitas de árbol; se rechaza excederlos. Pack/transporte: 60 s; comandos locales E6-A2 conservan sus límites.

## Garantías que no se atribuyen

Este es un adaptador host de operaciones fijas, no un sandbox de kernel de Git ni una habilitación de shell/red arbitraria. La cancelación Windows solicita terminación del árbol con `taskkill /T /F`, pero no tiene garantía Job Object/AppContainer. Cancelar después de empezar una petición puede dejar un efecto remoto: se muestra resultado incierto y se pide inspeccionar GitHub antes de repetir. No hay transacción distribuida entre comprobación REST y push; tampoco se garantiza que un tercero no cambie propiedad/visibilidad justo en ese intervalo. No se revierten publicaciones remotas silenciosamente.

No se implementan OAuth, Enterprise, creación en organizaciones, LFS, automatización, fetch/pull/merge ni publicación de repositorios referenciados. Linux no habilita credenciales hasta validar su backend. La evidencia prueba API con fixtures, preparación Git real y UI/DPAPI real sin cuenta ni publicación GitHub real; no se declara validación final de A3-035 en un servicio alojado. Véase [E6-B1](../e6/explicit-remote-publishing.md).
