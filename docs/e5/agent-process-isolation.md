# E5-E2 — procesos y herramientas del agente en Windows

Base: E5-E1 y E0-C2; A3 §§20.7/21, criterios A3-027/031/032.

## Decisión de seguridad

`process.run` permanece no disponible en la build Windows. El broker deniega la capacidad antes de preparar una ejecución. No existe un launcher de comandos arbitrarios conectado a Codex, las herramientas A3 ni IPC. Un perfil Trabajar, aprobación por operación, `cwd`, entorno reducido o una carpeta staging normal no cambian esa decisión.

E0-C2 se repitió en Windows 10 Pro 10.0.19045 con Node 24.13.1: 6 casos pasaron como arnés sintético, junction disponible y rechazado por las guardas del host; un `spawn` Node normal volvió a leer y escribir el fixture fuera de raíz por traversal y junction incluso tras revocación. Las aserciones de “no spawn” del arnés siguen siendo simuladas, no una barrera del kernel. No se probó AppContainer, token restringido, ACL dedicada, Job Object ni filtrado de red. El proceso heredó el token del usuario. Por eso A3 mantiene deshabilitada la ejecución arbitraria.

## Capa preventiva implementada

`agent-process.ts` proporciona validación host-only para futuras solicitudes: IDs de raíces aprobadas por host, identidad estable del directorio, comprobación de cada segmento de `cwd` en el último momento y rechazo de rutas absolutas, traversal, symlinks/junctions y raíces sustituidas. Rechaza requests que superen 120 s, 1 MiB de salida, 512 MiB de memoria, 8 procesos, 128 argumentos/64 KiB, un CPU budget mayor que el wall time, red solicitada o variables fuera de la lista pequeña permitida. El recolector de salida descarta el lote completo al exceder el límite.

El registro de tareas puede detener adaptadores registrados al revocar `process.run`; la revocación de cualquier capacidad efectiva también cierra la sesión local de Codex app-server de ese proyecto. La integración de Codex solo usa el transporte/protocolo del proveedor y las tools A3 mediadas; no recibe una herramienta de shell. Los adaptadores futuros deben asociar `stopTree` a la terminación de un Job Object comprobado, no solo al proceso padre.

La validación de rutas, límites y recolector no sustituyen controles OS. No hay enforcement de memoria/CPU/red/descendientes para un hijo porque ningún hijo de proyecto se inicia. Si A3 no puede lanzar con aislamiento Windows probado, debe seguir denegando `process.run`.

## Comprobaciones

`packages/project-store/test/agent-process.test.mjs` cubre traversal, cwd absoluto y raíz no aprobada, junction, límites de tiempo/CPU/salida/memoria/procesos/entorno/red, salida excesiva, revocación del registro y denegación efectiva antes del lanzamiento. `apps/desktop/test/codex-turns.test.mjs` prueba que una revocación cierra el proceso proveedor ligado al proyecto y que el transcript vuelve a abrirse sin mezclar proyectos. El test de junction se ejecuta en Windows.

**Criterios:** A3-031 — las capacidades permanecen separadas y `process.run` no se habilita por perfil; A3-032 — petición modificada no concede autoridad; A3-027 — el renderer remoto sigue aislado conforme a E5-A1. La sandbox de procesos arbitrarios y contención de red no quedan aceptadas.
