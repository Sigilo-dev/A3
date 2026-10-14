# Resumen de cierre E0 y entrada a E1

Fecha de síntesis: 2026-10-14. Esta página organiza la evidencia disponible al terminar E0-E; la especificación maestra 1.0.0 sigue siendo la fuente de alcance. La [matriz de compatibilidad](compatibility-matrix.md) contiene el estado separado de las comprobaciones de §30; [decisiones](decisions.md), [dependencias](dependencies.md) y [estimación E1](estimate-e1.md) amplían sus consecuencias.

## Qué quedó confirmado

- La rama `codex/e0-foundation` contiene E0-A, E0-B1, E0-B2, E0-C1, E0-C2, E0-D1, E0-D2 y E0-D3. No falta un prompt anterior de E0-A–D3 en la historia revisada. Los contratos reales son [dominio](contracts/domain.md), [comandos y migraciones](contracts/commands-and-migrations.md) y [extensiones](contracts/extensions.md); sus campos aún provisionales siguen marcados como tales.
- Los diez esquemas E0-A y fixtures sintéticos pasaron 34 pruebas con Ajv. JSON Schema no valida consistencia total entre documentos ni confiere permiso. Los contratos no prueban transacciones, migraciones, UI ni aislamiento.
- En spikes locales se verificaron algunas piezas: portada pública en `WebContentsView`, copia al portapapeles, handshake inicial local de app-server sin login, render/export de fixtures de diagramas, traversal simple de lienzo/dibujo, procesamiento de imágenes pequeñas y perfiles concretos de FFmpeg/ffprobe. La [matriz](compatibility-matrix.md) identifica alcance y comandos de cada prueba.
- En almacenamiento Windows, el harness sintético recuperó los dos archivos al inyectar terminación antes/después de reemplazos, detectó hashes/revisiones obsoletos y preservó bytes externos desconocidos. Ese resultado apoya diseñar writer único y revisión/hash, pero no prueba una implementación A3.
- Las versiones de los spikes están registradas con origen, runtime y licencia declarada en [dependencies.md](dependencies.md). Ninguna quedó aprobada automáticamente para distribuir.

## Qué sigue incierto o parcial

- El flujo integrado ChatGPT manual no llegó a pegar/enviar un prompt en la web; OAuth no se completó. A3-026–030 permanecen abiertos, aunque el handshake de app-server y la carga pública pasaron.
- El proceso hijo normal de Node escapó de la raíz lógica. No se probó AppContainer, token restringido, Job Object ni red. Los procesos arbitrarios deben permanecer deshabilitados hasta una barrera del sistema probada; `staging`/confirmación bajo el mismo usuario no los confina.
- Los casos de recuperación fueron terminaciones de proceso. No se cortó energía: no se afirma durabilidad ante pérdida real de energía. Tampoco se probaron journal truncado, recovery interrumpido, migrador o lock entre procesos de producto.
- Milkdown alteró un fixture al serializar un no-op. CodeMirror preservó esa fuente en el caso exacto; no se probó la edición y sincronización real entre vistas. Undo no se compartió entre editor/canvas. Los renderers de diagramas no demuestran conversión completa al modelo A3.
- FFmpeg Gyan 8.0.1 full-build observado es GPLv3; Sharp nativo Windows con libvips tiene obligaciones LGPL y avisos transitivos. El WAR de Structurizr no tiene auditoría legal completa. El paquete Electron debe incluir avisos Chromium. Las licencias/fuentes exactas de artefactos finales siguen pendientes.
- No se verificó Git local/remoto integrado con el proyecto. La estimación E1 no cuenta ese trabajo como aprobado. Los criterios A3 completos continúan sujetos a pruebas de aceptación de sección 29.

## Acciones que requieren una persona o infraestructura

| Quién desbloquea | Acción concreta | Qué habilita |
|---|---|---|
| Usuario con cuenta propia que quiera evaluar el agente | Completar personalmente OAuth y pruebas consentidas con una cuenta elegible; no entregar tokens al repositorio/agente. Comprobar al menos autorización, turno, error de límite y desconexión. | Evidencia real para A3-028–030. La cuenta debe ser elegible; la documentación no determina la elegibilidad de una cuenta concreta. |
| Propietario de A3 | Confirmar estrategia de paquete/distribución para GPLv3 de la build FFmpeg observada, licencias LGPL y avisos binarios; escoger una build concreta y revisar su source/flags/transitivas antes de empaquetar. Revisar también Structurizr WAR, PlantUML JAR, Chromium/Electron y Codex CLI. | Bloqueo de licencia y de versión para build/distribución; no afecta que las pruebas locales hayan pasado. |
| Responsable técnico de A3 | Elegir una frontera OS comprobable para los hijos (AppContainer/LPAC o token restringido con ACL), Job Object/descendientes y política de red; aprobar la capacidad `disabled` como fallback hasta superar pruebas. | Integración segura de perfiles de agente y plugins. No se requiere elevar permisos del usuario. |
| Responsable de pruebas/laboratorio | Solo si se promete durabilidad ante pérdida física de energía: preparar disco/equipo desechable y ensayo controlado de corte, recopilar estado después de reinicio. | Evidencia sobre energía que E0-C1 deliberadamente no produjo; no es prerrequisito para llamar “recuperación por caída de proceso” a lo ya ensayado. |
| Propietario/maintainer de adaptadores | Resolver KaTeX `<0.18.2` en el lock del spike Milkdown, revisar y volver a probar matemática y bloques desconocidos antes de usar Crepe en el producto. | Un pin de Markdown candidate sin la alerta E0 actual. |

Los únicos bloqueos externos observados fueron acotados: descarga DNS del tema remoto default de Structurizr (se quitó y se continuó localmente) y la falta de un ensayo físico de energía en el entorno disponible. No hubo bloqueo de la portada ChatGPT ni del `initialize` local; las fases de cuenta no se intentaron. La inspección de la característica opcional de Windows requirió elevación, que no se solicitó; no equivale a probar aislamiento ni a demostrar que AppContainer no exista.

## Orden de próximos prompts E1

La propuesta conserva los bloques A–F de §31.4 y no crea trabajo de producto fuera de ellos:

1. **E1-A — base Electron:** shell main/preload/renderer, IPC tipado, navegación y pruebas de seguridad del renderer. No implementar procesos de agente.
2. **E1-B — dominio:** tipos/IDs, referencias, comandos, validación, revisiones y errores derivados de los contratos E0-A; registrar ADRs puntuales para incertidumbres imprescindibles.
3. **E1-C — serialización y writer:** JSON UTF-8, `Resource` hash/revisión, un writer, staging/backup, conflicto externo y pruebas de contenido. No decir que varios `rename` son una transacción atómica.
4. **E1-D — journal/recovery:** máquina de estados, corrupción localizada, recovery interrumpible, snapshots y migración versionada; pruebas de reinicio de proceso y recuperación antes de activar escrituras generales.
5. **E1-E — capacidades/rutas/procesos:** guardas reales en el host, validación de junction/reparse, launcher OS, red/handles/descendientes y revocación; fallo cerrado si aislamiento no está disponible. Las herramientas mediadas son independientes de procesos arbitrarios.
6. **E1-F — flujo local:** crear/abrir proyecto y workspace, explorador, montajes, preferencias y estados de error; aceptación con la aplicación conectada al writer y broker reales.

Dependencias, D5 y rango por bloque se encuentran en [estimate-e1.md](estimate-e1.md). El total revisado E1 es **21–34 UT** frente a las **15–26 UT** iniciales; no es calendario ni extrapolación de duración de E0.
