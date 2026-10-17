# ADR 0024 — perfiles de agente con concesión efectiva local

Estado: aceptada para E5-E1. Base: E5-D2 `c8cb09b`, especificación A3 §§21.1–21.3 y criterios A3-031/032.

## Decisión

Consultar, Proponer, Trabajar y Personalizado se mantienen como perfiles independientes del actor agente. Los modos por capacidad distinguen denegado, solo propuesta, aprobación del host y acceso directo. El broker conserva el perfil y las excepciones aprobadas en estado host-local, separado de los datos portables del proyecto. La interfaz local de Preferencias ofrece lectura y cambios a través del broker; cada ampliación requiere confirmación del host.

`.a3/policies.json` es una petición portable sin autoridad. El broker la analiza para mostrar el perfil y las capacidades solicitadas, pero nunca la lee como concesión. Alterarla, importarla o clonarla no cambia la autorización almacenada en el dispositivo. Un proyecto clonado carece de la concesión local aunque conserve su archivo de política. Las operaciones continúan auditadas sin incluir rutas, tokens ni contenido arbitrario.

Las capacidades están agrupadas en lectura, escritura, procesos/shell, red, Git y aplicaciones. Git mantiene permisos distintos por acción. `apps.connect` tiene un identificador propio; conexiones de proveedores siguen en su flujo de cuenta independiente. Las capacidades de proceso, red, paquetes, aplicaciones y Git no disponibles permanecen bloqueadas aunque el perfil o una política pidan acceso.

El broker emite notificaciones al reducir el perfil, cambiar una concesión por otra más restrictiva o revocar una capacidad. Los consumidores pueden cancelar trabajos activos en el siguiente límite operativo.

## Evidencia y límites

`packages/project-store/test/security.test.mjs` prueba que una política compartida que solicita Trabajar/directo deja efectiva la concesión local Proponer, que una copia del proyecto no hereda permisos, que las categorías no se solapan y que revocar produce un evento y una denegación auditable. La interfaz presenta modo efectivo, motivo de denegación, solicitud del proyecto y capacidades actualmente no disponibles.

El panel configura el perfil y excepciones locales del proyecto activo; no crea una cuenta del sistema ni un sandbox. La solicitud JSON existente se presenta y no se sincroniza desde Preferencias, porque ese archivo todavía no dispone de una operación de escritura transaccional tipada. No se exponen rutas montadas ni detalles de la auditoría al renderer.

**Criterios:** A3-031, perfiles y efectos mediados por host, parcialmente cubiertos para permisos de dominio; A3-032, modificación/clonación de política no eleva la concesión, probado. Shell, red, Git, aplicaciones externas y ejecución de paquetes siguen denegados hasta disponer de integraciones y aislamiento demostrables.
