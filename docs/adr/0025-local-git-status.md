# ADR 0025 · adaptador Git local de estado

Estado: implementada para E6-A1. Base: E5-F2 `a2958a1`, especificación §§22.1–22.2, contratos E0-A, broker y raíces E1-E, evidencia E0-C2.

El adaptador vive en el host desktop: `git-process.ts` verifica instalación/ejecutable y contiene la lista cerrada de comandos; `git-status.ts` registra raíces y obtiene estado; `git-status-policy.ts` centraliza exclusiones. El dominio y los documentos portables no reciben rutas de ejecutable ni argumentos Git. Los DTOs públicos de estado están en `shared/git-status.ts`.

El host registra un ID independiente por repositorio con UUID de proyecto, clase `a3-project` o `referenced` y raíz absoluta aprobada localmente. El adaptador exige un autorizador explícito de `git.status`; para una raíz externa ese autorizador también debe comprobar la concesión local `mount.read`. Lo consulta antes y después de cada comando y falla cerrado ante excepción, revocación o retirada del binding. No se infiere autoridad del manifiesto ni se descubre el repositorio padre.

Esta entrega proporciona una API host-only que consume un autorizador; no añade IPC/UI, no conecta agentes y no cambia la lista de capacidades indisponibles del broker. La integración E6-A2 debe resolver sesión/proyecto/mount en el host, conectar el broker efectivo y ofrecer solo las operaciones verificadas. No puede usar `authorize: () => true` del fixture en producción.

Se admite la instalación opcional Windows x64 `2.53.0.windows.1`, con huella exacta del ejecutable nativo, licencia GPL-2.0-only comprobada y sin redistribuir binarios. No se busca `git` en el PATH del proyecto. La ruta configurada es una decisión del host; sin binario se obtiene `not-installed`, y una versión/huella distinta produce `unverified-binary`.

Solo se ejecutan `--version`, `rev-parse`, `ls-files` y `status`, mediante `spawn` con argumentos separados, `shell: false`, `windowsHide: true`, cwd explícito y entorno reducido. Se fija el git-dir/work-tree a la raíz aprobada; se desactiva configuración global/sistema, fsmonitor, helpers de diff, hooks, refresh opcional del índice y lazy fetch. Status usa porcelain v2/NUL, ignora submódulos y desactiva inferencia de renames (se presentan como borrado/alta). No hay stage/commit/restore ni acceso remoto en esta API.

Las raíces y `.git` se vuelven a observar por identidad antes/después de los comandos. Se rechazan junctions/symlinks, gitfiles, alternates, repositorios anidados, worktrees compartidos y configuración de includes/filtros/attributes externos. El rechazo de tokens de configuración es conservador y puede incluir comentarios/valores inocuos. Los repositorios que necesitan esos mecanismos quedan diagnosticados hasta que exista una adaptación específica; no se ejecutan filtros de usuario para obtener estado.

Las exclusiones cubren `.a3/local`, nombres habituales de credenciales/claves y cachés, también si el índice ya los contiene. El estado solo devuelve rutas portables admitidas; reporta un conteo/diagnóstico de archivos protegidos trackeados sin listar sus nombres. No modifica `.gitignore`, no elimina bytes ni borra secretos del historial. Futuras operaciones de escritura deben aplicar la misma política además de revisar la selección.

Las guardas antes/después no constituyen una sandbox de kernel ni garantizan que otro proceso hostil no cambie un enlace en el intervalo exacto de una syscall. No habilitan `process.run`. La preinspección tiene presupuesto de 50 000 entradas; cada proceso tiene 10 s y 8 MiB combinados de salida, con resultados parciales descartados. Un repositorio vivo puede cambiar índice/contenido durante la consulta: el DTO es observacional y no sirve como precondición para una escritura futura. E6-A2 deberá releer y validar su propia revisión/diff antes de aplicar.

Evidencia y límites de A3-034: [E6-A1](../e6/local-git-status.md).
