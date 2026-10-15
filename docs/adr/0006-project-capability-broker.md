# ADR 0006: concesiones efectivas en un broker local por proyecto

Estado: aceptada para E1-E1.

## Contexto

La política compartible de un proyecto puede viajar en `policies.json`, ser editada por un agente o venir en un clon. No puede otorgar permisos efectivos. Además, la evidencia E0-C2 mostró que una guarda lógica de rutas no contiene procesos de Windows; no se demostró aislamiento de red ni ejecución segura de paquetes.

## Decisión

El proceso principal emite un `ProjectCapabilityBroker` ligado a un actor autenticado, y `openProjectService` rechaza otros objetos. El servicio usa ese broker para leer, preparar y aplicar cambios; el kernel recibe decisiones estructuradas. Las concesiones efectivas se guardan fuera del proyecto y se vinculan a su ruta canónica y UUID. Perfil, concesión y revocación requieren confirmación local. El broker vuelve a leer las concesiones por operación y falla cerrado si su almacén o auditoría no está disponible.

Los perfiles `consultar`, `proponer`, `trabajar` y `personalizado` solo afectan capacidades documentales, diagramas y tareas según su nivel; el permiso de eliminación se mantiene separado. Procesos, red, instalación de paquetes, Git y exportación permanecen sin disponibilidad efectiva hasta que exista un adaptador y evidencia de sus límites. Los requests compartibles no se cargan ni se fusionan automáticamente en el almacén local.

## Consecuencias

Un proyecto clonado requiere aprobación local propia. Revocar tiene efecto en la siguiente autorización. El registro local solo contiene claves opacas, actor, operación, capacidad y resultado, sin prompts ni contenido; no se afirma que sea resistente a manipulación por el mismo usuario del sistema. La interfaz de configuración y su conexión IPC quedan para una etapa posterior; no se debe exponer una referencia del broker al renderer o a un agente.
