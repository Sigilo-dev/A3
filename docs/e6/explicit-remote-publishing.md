# E6-B1 · publicación remota explícita

Base comprobada: `codex/e3-e7-product`, E6-A2 `e395bfb`, origin `https://github.com/Sigilo-dev/A3.git`, árbol limpio inicial. No se integra otra rama. Se leyeron especificación §§22.1/22.2/22.4, A3-035, contratos E0-A, decisiones E0, evidencia E0-C2 y ADR 0025/0026. Decisión nueva: [ADR 0027](../adr/0027-explicit-github-publishing.md).

## Comportamiento entregado

La pestaña GitHub conserva las operaciones locales y añade un panel de publicación. A3 sigue funcionando sin remoto ni credencial. No hay OAuth configurado; la interfaz lo declara y permite conectar manualmente un token personal por confirmación nativa y lectura del portapapeles exclusivamente en host, o abrir el flujo externo en el navegador. No solicita una API key del desarrollador.

Se puede crear un repositorio vacío en la cuenta personal autenticada (privado inicialmente) o elegir un destino existente por URL HTTPS. La revisión muestra cuenta/ID, raíz A3, URL, visibilidad, ID del repositorio existente, rama destino, commit, archivos/tamaños y exclusiones. Se debe escribir la URL exacta antes de confirmar. Crear no autoriza push. Cada push exige revisión propia, confirmación de destino y permiso efectivo. La aplicación no modifica `origin` ni conecta automáticamente otro proyecto o repositorio montado.

Credenciales solo en el almacén protegido del host Windows/DPAPI, fuera del repositorio; no en IPC, renderer, configuración Git ni logs. Desconectar elimina la copia local y cancela operaciones, sin cerrar el chat web ni revocar el token en GitHub. El token necesita permisos para el repositorio y para la acción elegida. Sin permisos, motor verificado, cuenta o almacén protegido, la operación se detiene y conserva el proyecto local.

## API actual y motor verificados

Consulta documental: 2026-10-17. Se fijan API REST `2026-03-10`, `GET /user`, `GET /repos/{owner}/{repo}` y `POST /user/repos`, validando los campos requeridos. Fuentes oficiales: [usuario autenticado](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), [obtener repositorio](https://docs.github.com/en/rest/repos/repos#get-a-repository), [creación personal y permisos](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user), [autenticación REST](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api). La API no reemplaza el transporte ni la historia Git.

Se conserva Git for Windows nativo `2.53.0.windows.1`, licencia GPL-2.0-only, versión/huella verificadas en [E6-A1](local-git-status.md). Se comprobó además el helper instalado `mingw64/libexec/git-core/git-remote-https.exe`: **2 589 600 bytes**, SHA-256 **`937b7b8f2f9c0b37a47c141714abf249f9a497127880cffd4182ca7813c4b57d`**. No se descargan/redistribuyen Git, helpers ni DLLs. No se audita toda la distribución ni se garantiza otro binario/OS.

El push usa una copia bare temporal de los objetos revisados, sin la configuración del proyecto. El destino y refspec son explícitos; no usa force, hooks, reescritura de URLs, proxy heredado, tags ni helpers de credenciales. Referencia: [semántica oficial de git push](https://git-scm.com/docs/git-push). Un fallo o interrupción después de comenzar la mutación remota puede ser incierto y nunca se reintenta automáticamente.

## Evidencia ejecutada

```text
npm run test:github --workspace @a3/desktop
npm run test:git --workspace @a3/desktop
node --test packages/project-store/test/security.test.mjs
npm run build --workspace @a3/desktop
npm run test:github:smoke --workspace @a3/desktop
npm run test:git:smoke --workspace @a3/desktop
git diff --check
```

Resultado observado: **11/11 pruebas E6-B1, 24/24 Git local y 7/7 de permisos**, sin skips; ambos smoke Electron y build/tipos aprobados. Los fixtures de cuenta/repositorio son sintéticos: `fixtures/e6/git/github.json`. Las pruebas usan temporales, respuestas REST falsas y un token generado para el test. No leen credenciales reales ni publican fixtures en GitHub.

- Once pruebas E6-B1: schema IPC, URLs maliciosas/credenciales/lookalikes, revisión sin efectos, apply explícito, cancelación, revocación y cambios de proyecto/HEAD/rama/token; revalidación de cuenta, ID remoto, visibilidad y permiso; creación privada separada del push; cancelación durante transporte con resultado incierto y sin repetición; headers/API/redacción; vault sin fallback y corrupción preservada.
- Git real: se escanea historia, se genera pack y se importa en bare aislado preservando OID/contenido, índice y configuración originales. Se rechaza destino ajeno y cambio de configuración del staging. Secretos, exclusiones y LFS siguen bloqueados aunque se hayan borrado después; symlinks/gitlinks no están soportados. Helper HTTPS con hash comprobado.
- Broker real: permiso `git.push` separado de `network.access` genérico, cancelación de aprobación, actor agente ajeno, clone sin concesión y permiso concedido.
- Smoke Electron: cuenta y destino, visibilidad privada, exclusiones, URL equivocada, cancelación nativa, creación separada, importación host de portapapeles, **cifrado DPAPI real** de token sintético, desconexión y flujo externo. HTTP siempre simulado, no hay llamada remota real.
- Regresión E6-A1/A2: 24 pruebas Git y 7 de permisos; smoke local de stage/commit/restore. Tipos/build pasan; persiste aviso previo de chunks grandes del renderer. No cambian dependencias ni lockfile.

## Criterios y límites

**A3-035, implementación con evidencia controlada:** conectar cuenta manual, crear/elegir destino y push explícito con revisión, cancelación, autorización y rechazo de destino equivocado. La API y transporte están implementados; no se declara prueba de extremo a extremo contra GitHub con una cuenta real. OAuth queda ausente de forma explícita, con flujo manual útil. No se declara aprobado todo §22.2 ni el aislamiento genérico de E0-C2.

**A3-034/031/032, regresión y partes aplicables:** las acciones locales se conservan; la credencial no amplía permisos, y un clone/agente no obtiene concesión. No hay herramienta de push para agentes ni automatización. Solo el proyecto A3 activo se publica; repositorios referenciados mantienen su raíz independiente sin nueva escritura.

Requiere proyecto Git con commit válido. Crear en organizaciones, Enterprise, OAuth, Linux, LFS, otras operaciones remotas y selección persistente de remote quedan fuera. El escáner bloquea el historial completo si encuentra datos excluidos; no limpia historia ni garantiza detectar todo secreto. Límites de objetos/tamaño/tiempo se documentan en ADR 0027. No hay sandbox de kernel ni transacción distribuida con GitHub; cancelar no asegura deshacer una escritura ya recibida. Las comprobaciones REST no evitan cambios de terceros exactamente entre validación y push.
