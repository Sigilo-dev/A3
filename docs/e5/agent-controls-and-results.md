# E5-F2 · controles del agente y vistas de resultados

Implementación para §§20–21 y criterios A3-028–033. La vista de Agente separa autorización de cuenta, catálogo/modelos comprobados, transporte de turnos y concesiones efectivas del proyecto. Los estados de proveedor pasan por una proyección de presentación en `apps/desktop/src/shared/codex-agent-view.ts`; no concede permisos ni envía solicitudes.

## Comportamiento visible

- La autorización oficial existente muestra cuenta, elegibilidad, permiso del plan, vencimiento, límite y errores. “Permiso del plan” se distingue de inferencia y disponibilidad real de modelo.
- En esta instalación no hay un catálogo verificado: se muestran cero modelos. Un acceso denegado no habilita una ruta alterna ni cambia a API paga.
- La UI muestra el app-server sin configurar, turno no iniciado y streaming inactivo. Iniciar, detener y reanudar permanecen deshabilitados. Abrir un proyecto no inicia procesos Codex.
- La sesión puede continuar con el compilador E4 para copiar un prompt o con la pestaña web manual. Son rutas explícitas e independientes; no cuentan como turnos automatizados.
- Con un proyecto abierto, la vista lee del host solo capacidades efectivas marcadas disponibles y su modo. Capacidades no disponibles se omiten. El texto advierte que autorización/modelo no amplía el perfil y que la solicitud portable no concede acceso.
- Sin un turno real no hay propuestas entrantes. La vista dice que no existen resultados en esta sesión y no muestra contenido ficticio.
- La proyección reconoce límite agotado, acceso a modelo/ruta denegado y pérdida de conexión. En desconexión el resultado se marca incierto y no se reenvía. La UI no recibe todavía eventos del turn ledger, pues no existe inicio de turno ni puente de turnos en renderer.

## Pruebas y validación

`fixtures/e5/agent-controls/states.json` contiene estados sintéticos de límite, ruta/modelo no accesible y stream perdido. `apps/desktop/test/codex-agent-view.test.mjs` verifica los mensajes, que no se exponga modelo no accesible, que sin catálogo no haya modelos, y que conexión perdida no habilite stop/reanudar/replay. El caso de catálogo verificado prueba filtrado y deduplicación, pero el build actual no ofrece ese catálogo.

Comprobaciones Windows:

```text
npm run test:ai:controls --workspace @a3/desktop
npm run typecheck --workspace @a3/desktop
npm run build --workspace @a3/desktop
npm run test:auth --workspace @a3/desktop
npm run test:codex:turns --workspace @a3/desktop
npm run test --workspace @a3/domain
npm run test --workspace @a3/project-store
npm run test:variables --workspace @a3/desktop
npm run test:planning --workspace @a3/desktop
npm run test:memory --workspace @a3/desktop
```

El dominio y el store validan con fixtures de E3 y E4: C4, conceptual, UML, ER, IoT, variables, prompts, historias/tareas, memoria, permisos y propuestas. Resultado: controles 4/4, dominio 165/165, store 234/234, autorización 27/27 y turnos 24/24; typecheck/build pasan. El build conserva el aviso de chunks grandes del renderer. La suite del store tardó unos tres minutos en Windows por pruebas que reinician/reabren proyectos.

## Cierre de evidencia E5 por criterio

| Criterio | Evidencia acumulada | Límite actual |
|---|---|---|
| A3-028 | OAuth oficial y UI de cuenta; almacenamiento del host; estados sintéticos y desconexión. | No se comprobó cuenta elegible ni turno de inferencia de extremo a extremo; no se ofrece inicio de turno. |
| A3-029 | Estados de límite agotado y acceso a ruta/modelo denegado cubiertos con fixtures; sin fallback de API. | Catálogo, disponibilidad y cuotas reales no están conectados al app-server. |
| A3-030 | Ledger local probado ante stream perdido, cancelación e interrupciones; UI no asegura replay. | UI no puede detener/reanudar un turno real; app-server no tiene inicio de turno conectado. |
| A3-031 | La UI consume las capacidades y el perfil efectivos del broker local; `process.run` sigue indisponible. | No hay herramienta de agente en UI que aplique cambios desde un turno Codex. |
| A3-032 | Solicitudes compartidas siguen separadas de concesiones locales; cubierto por tests del store y panel de permisos. | E5-F2 no añade una nueva ruta de elevación; clon real no concede permisos automáticamente. |
| A3-033 | Propuestas/herramientas A3 están verificadas en `packages/project-store/test/agent-tools.test.mjs`; la UI no finge que las recibió. | La revisión/aplicación de una propuesta de un turno Codex aún no está conectada al renderer. |

Referencias: [E5-B1](chatgpt-authorization.md), [E5-B2](authorization-lifecycle.md), [E5-C1](codex-app-server-adapter.md), [E5-C2](resumable-turns.md), [E5-D1](a3-tool-contracts.md), [E5-D2](../adr/0023-scoped-a3-agent-tools.md), [E5-E1](../adr/0024-agent-capability-profiles.md), [E5-E2](agent-process-isolation.md), [E5-F1](traceable-context-and-a3-skill.md). Esta es la evidencia de cierre de E5 disponible en el código y las pruebas; A3-028–030 y la integración visible de A3-033 siguen parciales hasta conectar un artefacto/protocolo de proveedor aprobado.
