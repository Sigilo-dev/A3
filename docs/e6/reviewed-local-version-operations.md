# E6-A2 · operaciones locales de versiones revisadas

Base comprobada: `codex/e3-e7-product`, E6-A1 `d94c13a`, origin `https://github.com/Sigilo-dev/A3.git`; árbol limpio al comenzar. No se cambia la base ni se integran ramas. Fuente: especificación §22.2/A3-034, contratos E0-A, evidencia E0-C2 y servicios de permisos, snapshots, writer y journal E1. Decisiones: [ADR 0026](../adr/0026-reviewed-local-git-operations.md).

## Uso

Abrir la pestaña GitHub de un proyecto con Git local muestra «Proyecto A3 · Git local», raíz, rama y estado. Seleccionar archivos y «Revisar stage» permite revisar diff antes de aplicar, con selección de hunks para un archivo textual. «Revisar unstage» conserva los bytes del archivo. El commit pide autor, email y mensaje y muestra todo el índice revisado. Crear rama es explícito y conserva la rama activa. Restore admite HEAD o uno de los últimos 30 commits, muestra también los ajustes de revisiones y crea un punto de retorno antes de escribir. El retorno vuelve a pasar por revisión, permisos y journal.

Permisos denegados, borradores sin guardar, cambio de revisión/índice/HEAD, secretos, LFS/filtros y conflictos se muestran como errores; no se presentan como éxito. Cancelar una revisión no altera índice/worktree. Sin Git, sin repositorio o con motor incompatible, A3 conserva la apertura local del proyecto y muestra el estado del adaptador.

## Motor y aislamiento

Se conserva Git for Windows nativo `2.53.0.windows.1`, GPL-2.0-only y SHA-256 `d09a1324132aa9da4b4c2b14242dcac893539a735fab288136b101156434a55a`, comprobado en E6-A1 y revalidado antes de ejecutar. No se actualizan paquetes ni se agregan dependencias. Véase [evidencia de motor E6-A1](local-git-status.md). No hay acceso remoto, credenciales Git, shell genérico ni ejecutable facilitado por renderer.

## Verificación reproducible

Ejecutada en Windows x64, con fixtures sintéticos en directorios temporales y Git real; no utiliza snapshots ni repositorios personales:

```text
npm run test:git --workspace @a3/desktop
node --test packages/project-store/test/security.test.mjs
node --test packages/project-store/test/maintenance.test.mjs packages/project-store/test/writer.test.mjs
npm run build --workspace @a3/desktop
npm run test:git:smoke --workspace @a3/desktop
git diff --check
```

Resultado: **24/24 pruebas Git, 7/7 de permisos y 31/31 de writer/mantenimiento**, sin skips; build/tipos y smoke Electron aprobados. La suite Git incluye las 15 pruebas E6-A1 y nueve pruebas E6-A2. Los fixtures están en `fixtures/e6/git/versions.json`. Casos E6-A2:

- IPC rechaza comandos, raíces y tokens arbitrarios; no expone Node al renderer.
- Stage de uno de dos hunks conserva el otro y el archivo no seleccionado; commit contiene solo el índice revisado, ignora hooks y deja intacto el worktree.
- Crear rama Unicode explícita conserva HEAD; no se reutiliza una revisión aplicada.
- Cambios externos de índice, archivo o HEAD invalidan el plan sin sobrescribirlos.
- Secretos sintéticos, rutas protegidas, filtros/LFS de proyecto o `.git/info/attributes`, borradores y revocación se rechazan.
- Unstage/cancelación conservan bytes; `index.lock` ajeno no se elimina. Un merge conflictivo real conserva índice y contenido.
- Restore de fuente registrada mantiene Resource ID, incrementa revisiones, deja el índice exacto y crea snapshot; retorno incrementa otra vez la revisión. Un archivo ajeno al proyecto queda intacto.
- Fuente externa posterior y JSON canónico inválido se preservan con error. Interrupción inyectada después de instalar un archivo se recupera al reabrir mediante E1.

El smoke real de Electron recorre abrir proyecto, revisar sin modificar índice, stage selectivo por archivo, commit, restore/retorno con snapshot, veto de borradores, sesión inválida, raíz IPC rechazada y foco de teclado. El build incluye comprobación de tipos; conserva el aviso previo de chunks grandes del renderer.

## Cobertura y límites

**A3-034:** se comprueban diff, stage/unstage, commit, log, creación/listado de ramas y restore local sin GitHub, incluyendo validez de metadatos restaurados. No se declara completo todo §22.2: checkout entre ramas y resolución de conflictos, fetch/pull/merge/push quedan para entregas posteriores. La interfaz presenta solo las acciones implementadas.

**A3-031/032 y A3-038/046–048, parte aplicable:** broker efectivo, rechazo de secretos/exclusiones, snapshot/journal y conflictos por escrituras posteriores. Se reutilizan las garantías E1; no se anuncia atomicidad de varios archivos ni tolerancia demostrada a corte eléctrico real.

La integración visual es del repositorio del proyecto A3; la adaptación de raíces referenciadas sigue siendo solo lectura en E6-A1. Restore completo del árbol, cambios de IDs, borrados con referencias vivas o documentos incompatibles pueden rechazarse y requieren un conjunto válido explícito. Máximos: 128 archivos, 8 MiB por archivo, revisión de 32 MiB, cinco minutos por token; Git limita tiempo/salida. Binarios muestran tamaño/hash, no comparación visual. No hay soporte LFS activo, distribución de Git ni garantía universal del detector de secretos. Las comprobaciones no impiden carreras hostiles al nivel del kernel. Los tokens de retorno son de sesión; los snapshots persistentes conservan las copias según la retención E1.
