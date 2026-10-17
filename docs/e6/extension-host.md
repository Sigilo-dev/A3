# E6-E1 — host de extensiones por capacidad y proyecto

Base: A3 §§21/24.4, A3-043; [ADR 0031](../adr/0031-capability-scoped-extension-host.md), [E0-C2](../e0/compatibility/windows-process-isolation.md), [E5-E2](../e5/agent-process-isolation.md).

## Contrato

`schemas/e1/programmed-extension.schema.json` y `fixtures/e6/extensions/programmed-extension.json` definen el nuevo perfil. Conserva los campos de identidad, licencia declarada, API exacta, contribuciones y extensiones del envelope E0; permite entrypoint declarado con hash y añade scopes. No altera el perfil declarativo ni activa contribuciones desconocidas. El host valida además referencias de scopes/permisos, rutas portables, nombres Windows reservados, orígenes sin credenciales/path/wildcard e IDs. Se acepta un JSON UTF-8 de hasta 256 KiB. La integridad del manifiesto se verifica al cargar el estado local; el hash del entrypoint es solo una declaración: no se lee ni se ejecuta su archivo.

| Capacidad solicitada | Scope admitido | Estado efectivo actual |
|---|---|---|
| `project.read` | IDs de recursos del proyecto | Deshabilitada para código de extensión |
| `document.edit` | IDs de recursos; escritura futura por comandos/revisión | Deshabilitada para código de extensión |
| `network.access` | Orígenes HTTPS exactos | Deshabilitada |
| `process.run` | IDs de ejecutables del host | Deshabilitada |

El host solo registra aprobaciones humanas locales por capacidad, mediante diálogo nativo separado. No convierte una aprobación en permiso efectivo, no usa el actor humano para ejecutar una herramienta de plugin y no hereda el perfil Trabajar. El contrato lógico por recurso rechaza otra identidad de proyecto, paths, scope ausente, capacidad no declarada y escritura no aprobada. No hay una operación IPC de invocación de herramientas.

La pestaña de nodos construye solo un borrador JSON en el renderer y delega validación al host. El smoke detectó que el constructor de dominio anterior importaba Ajv y compilaba esquemas en el renderer bajo CSP; se eliminó esa importación runtime para que el gestor abra y conserve `script-src 'self'`, sin habilitar evaluación de cadenas. El smoke verifica también el preview del creador declarativo existente.

## Ciclo de vida

1. Revisar manifiesto no registra ni ejecuta nada. Preview muestra IDs, integridad, versión anterior y diferencias de permisos/scopes.
2. Aplicar consume un token efímero ligado a sesión, raíz e identidad, hash del catálogo y generación de revocación. Revalida todo tras la confirmación nativa. Un cambio de raíz, catálogo o concesión invalida la revisión.
3. La nueva versión queda desactivada y sin aprobaciones. No se sobrescribe una versión con contenido distinto. Registrar otro código/esquema no migra datos existentes.
4. Revocar/desactivar/quitar invalida sesiones de forma síncrona y pide terminación a los adaptadores registrados. La prueba usa callbacks; no existe proceso real porque el arranque está bloqueado. Un fallo de terminación no rehabilita tokens.
5. Quitar elimina solamente el registro local. Entidades, propiedades, contenido, archivos y relaciones continúan intactos en el proyecto/fallback.

El catálogo está en `<perfil de aplicación>/extension-host/<hash de raíz-identidad-UUID>.json`, junto a auditoría NDJSON. No se importa del proyecto ni se copia a Git. Cambios del catálogo se serializan y escriben por temporal en la misma carpeta. Se limita a 100 registros/2 MiB. Esto es configuración local de un archivo; no se presenta como transacción portable de varios archivos ni como sandbox. Archivos locales inválidos se conservan y bloquean nuevas operaciones.

## Evidencia y límites

Comandos reproducibles:

```powershell
npm run typecheck
npm run test:extensions --workspace @a3/desktop
npm test --prefix experiments/e0/windows-isolation
npm run build
npm run test:extensions:smoke --workspace @a3/desktop
```

Las pruebas de fixtures cubren validación y hash de manifiesto, aprobación nativa, cuatro permisos independientes, actualización sin herencia, cancelación, revocación, callbacks de terminación fallidos, clon con mismo UUID, invocaciones cross-project, traversal/paths absolutos/ADS, junction/raíz movida y sustituida durante aprobación, corrupción local y auditoría. El fixture hostil contiene intentos de Node, procesos, red e IPC; no se evalúa: se comprueba que el host no carga código y deniega `start` aun con todas las aprobaciones locales.

Resultado observado el 2026-10-17: build/typecheck correctos; 16/16 pruebas del host; 22/22 pruebas enfocadas del broker, agent-process y node-packages; smoke Electron con 11 comprobaciones correctas, incluyendo un WebContents ajeno con el mismo preload rechazado por el host, navegación accesible, preview declarativo sin eval y conservación de todos los archivos originales del fixture de proyecto. No se ejecutó la suite integral del repositorio en este bloque.

E0-C2 se repitió el 2026-10-17 en Windows 10 Pro 10.0.19045 / Node 24.13.1: 6 casos, 0 fallos. El hijo ordinario volvió a leer/escribir fuera de la raíz sintética por traversal/junction incluso tras revocación. Se usaron solo carpetas temporales. Por tanto el resultado vuelve a justificar deshabilitar ejecución; no acredita una sandbox ni una política de red.

A3-043 queda **parcial**: controles preventivos, actualización/desactivación y revocación lógica cubiertos; ejecución aislada real, revocación del árbol de procesos, red y recursos del SO sin aceptación. El registro de aprobaciones inefectivas, sus pruebas y el smoke de Electron no cambian esa conclusión. No se añadieron dependencias ni binarios.
