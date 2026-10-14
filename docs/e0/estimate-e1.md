# Estimación revisada para E1 — Base local

Fecha de revisión: 2026-10-14. Este documento estima **solo la implementación E1**, separada del trabajo E0 de contratos y viabilidad. Usa las UT de §31.1 de la especificación: una UT es una unidad verificable de trabajo futuro; no equivale a una hora, prompt, commit o respuesta. E0 no registró tiempos/person-horas ni asignó UT observadas por entrega. Por eso este ajuste es una estimación de planificación, con confianza media-baja, basada en los rangos previos y en los riesgos concretos descubiertos, no una medición de productividad.

## Rango revisado por bloque

| Bloque | Resultado de la especificación | Dependencias de trabajo | Dificultad | Rango anterior | Rango E1 revisado | Justificación a partir de E0 |
|---|---|---|---:|---:|---:|---|
| E1-A | Base Electron/React/TypeScript, main/preload/renderer, IPC tipado y navegación inicial. | E0-A contratos y E0-B1 controles de `WebContentsView`; crear shell aislado. | D3 | 2–3 UT | **2–3 UT** | `WebContentsView` pudo aislarse en una PoC, pero no hay app shell productivo. Mantener el rango supone no incorporar login ni permisos de procesos en este bloque. A3-026 full-flow sigue pendiente. |
| E1-B | Núcleo de entidades, recursos, relaciones, comandos, revisiones e invariantes. | E1-A para integración, E0-A contratos/esquemas/fixtures. | D4 | 2–4 UT | **3–5 UT** | E0-A validó 10 esquemas y fixtures (34 casos), pero explícitamente no implementó refs dinámicas, commands, revisions, idempotencia durable o Group/Variable/Mount/Policy. E0-D1 confirma que estado de UI no sustituye al modelo canónico. |
| E1-C | Serialización, lectura/escritura, transacciones y detección de cambios externos. | E1-B; ADR de revisión/hash/identidad, formato canónico y escritor único antes de fijar almacenamiento. | D5 | 3–5 UT | **4–6 UT** | C1 demostró una secuencia recuperable pequeña, pero no writer A3; C2 mostró que guardas lógicas no contienen procesos. Falta writer real, bloqueo interproceso, watcher, promoción de archivos externos y caso de múltiples documentos en el runtime Electron. |
| E1-D | Journal, recuperación, snapshots, conflictos, migraciones y corrupción localizada. | E1-C y ADR de journal/lock/recovery. | D5 | 3–5 UT | **4–7 UT** | C1 pasó seis puntos de terminación, pero no journal truncado, fallo dentro del journal, recovery interrumpido, caída de Electron, migración o pérdida real de energía. E0-A solo describe migraciones; no hay migrador. El rango añade estados de recuperación y pruebas que el spike dejó abiertos. |
| E1-E | Broker de capacidades, permisos efectivos por proyecto y validación de rutas reales. | E1-A/B; integrar con E1-C para writer; decidir aislamiento OS antes de habilitar procesos. | D5 | 3–5 UT | **5–8 UT** | C2 probó bypass real por un hijo Node, incluso tras revocación; sandbox/fail-closed se simuló y no se probó red, AppContainer, token restringido ni Job Object. Se necesita un launcher comprobable o mantener ejecución arbitraria deshabilitada. Más que checks de rutas, requiere pruebas negativas por perfil y mecanismo OS. |
| E1-F | Crear/abrir proyectos, explorador, montajes, preferencias base y errores recuperables. | E1-A–E; integra store, broker y contratos E0-A. | D4 | 2–4 UT | **3–5 UT** | Ningún spike creó o abrió proyectos A3, incorporó carpetas reales, probó montajes persistentes, watcher de UI o recuperación visible. Los fixture/rutas sintéticas no reducen el trabajo de integración de extremo a extremo. |
| **E1 total** | **A3-001–003, A3-024, A3-045–048 en alcance implementado** | **A3 y el contrato de E0** | **D5** | **15–26 UT** | **21–34 UT** | **Aumento de planificación: +6 UT mínimo y +8 UT máximo.** Impulsado principalmente por el aislamiento OS aún no comprobado y por limitar la garantía del writer a lo que fue ensayado. |

Los bloques se expresarán en prompts separados y revisables según el tamaño de §31.1. Los bloques de 5–8 UT son demasiado grandes para un prompt indivisible y deben dividirse en unidades de implementación/prueba sin cambiar el alcance.

## Orden propuesto para redactar prompts E1

1. **E1-A:** shell de Electron, límites main/preload/renderer, IPC tipado y carga de renderer; sin lógica de proyecto ni comandos arbitrarios.
2. **E1-B:** core independiente de UI: tipos implementados desde contratos E0-A, referencias locales, validación semántica, envelope de comandos y errores. Mantener explícitas las áreas pendientes del contrato.
3. **E1-C:** lector/escritor de documentos en fixtures y carpeta de proyecto sintética; establecer revisión/hash, JSON canónico y un escritor único. Antes de escribir proyectos del usuario, cubrir errores y copia/backup recuperable.
4. **E1-D:** journal, estados/recovery, conflicto externo, corrupción localizada y migración versionada. Priorizar recuperación/revisión antes de activar escritura en UI. No decir “durable ante pérdida de energía” sin ensayo físico específico.
5. **E1-E:** broker de capabilities por perfil y rutas reales. Implementar con prueba negativa a nivel OS antes de permitir spawn; si launcher o aislamiento fallan/no están disponibles, fail closed. Separar acceso a herramientas mediadas de comandos arbitrarios y red.
6. **E1-F:** integrar crear/abrir, workspace inicial, explorador, montajes, preferencias y estados de error; ejecutar las aceptaciones de E1 con app real, cerrar/reabrir y fixtures de recuperación.

E1-E puede preparar un prototipo nativo en paralelo después de E1-A, pero no debe exponer ejecución a la UI hasta superar sus pruebas y conectarse a la decisión de permisos. E1-F depende del servicio de proyecto y el broker; no comenzar como maqueta que sugiera persistencia o aislamiento ya disponible.

## Base de la revisión y confianza

La estimación inicial de §31.4 para E1 fue 15–26 UT. En la planificación E0 asignó 10–18 UT totales a E0-A (2–3), E0-B (2–4), E0-C (3–5), E0-D (2–4) y E0-E (1–2). Las pruebas terminaron repartidas en ocho entregas/prompts concretos A–D3, y esta síntesis corresponde a E0-E. La cantidad de prompts/commits **no** se convierte en UT: la especificación define escalas distintas.

Resultados que justifican el ajuste: E0-A dejó contratos y 34 pruebas estructurales sin persistencia/comandos reales; E0-C1 completó 13 casos sintéticos sin corte eléctrico, journal truncado o recovery interrumpido; E0-C2 mostró que un hijo ordinario escapa de las guardas lógicas; E0-D1 falló conservación semántica no-op de Milkdown; B1/B2 quedaron parciales por no completar flujo manual ni autenticación; los spikes de diagramas/medios no son módulos integrados. Las notas vinculadas especifican el alcance exacto.

No se reportó calendario ni costo monetario. El principal rango de incertidumbre es E1-E (5–8 UT): si los mecanismos OS comprobables no pueden ajustarse al alcance, A3 debe mantener la capacidad arbitraria apagada y reestimar solo si el propietario cambia esa decisión. La línea de base segura de E1 puede completar el resto con comandos mediados por host.

La distribución final de E1 sigue siendo 21–34 UT. No incluye E2, E3, aceptación integral E7, licencia legal externa, investigación de un cambio de especificación ni la hipotética certificación de resistencia a corte eléctrico.
