# E6-E2 — actualización y ciclo de vida de extensiones

Base: A3 §§21/24.2/24.4, A3-043 y el contrato E6-E1 en [extension-host.md](extension-host.md). Conserva el límite de seguridad de [E0-C2](../e0/compatibility/windows-process-isolation.md): Windows no tiene un launcher de plugins aislado aceptado por A3.

## Actualizar un manifiesto registrado

La interfaz importa un manifiesto UTF-8 de hasta 256 KiB. El host valida el perfil estricto, el API exacto `1.0.0`, la licencia declarada, las capacidades y scopes, y una versión SemVer superior. Una misma versión no puede cambiar de contenido. El preview enseña licencia, hashes, permisos y cambios de scope. La persona marca que revisó licencia y permisos y confirma el cambio en un diálogo nativo; la petición IPC por sí sola no autoriza la actualización.

Después de confirmar, el host escribe los bytes exactos del manifiesto en el staging local ligado al proyecto. Vuelve a comprobar el hash de bytes de origen y el hash canónico del manifiesto antes de activarlo. Activa el registro mediante el reemplazo atómico del único archivo local de estado. Conserva la versión previa para rollback y crea la nueva versión desactivada, sin aprobaciones. Si falla staging, comprobación, revisión de sesión o activación, el archivo de estado activo conserva sus bytes y el candidato temporal se elimina. Las concesiones previas solo se limpian al confirmar la actualización.

El estado local pasa de schema `1.0.0` a `1.1.0` en la primera escritura aprobada. Leer el formato anterior no lo reescribe. La migración conserva las entradas y aprobaciones ya guardadas. Rollback requiere confirmación, restaura la versión anterior como desactivada y sin permisos, y deja la versión que estaba activa disponible para volver a ella. No toca el contenido portable del proyecto.

## Desactivar, quitar y revocar

Desactivar borra las aprobaciones locales, invalida las leases del host antes de solicitar terminación y conserva el registro. Las vistas de nodos permanecen en fallback genérico con entidades, fuente, propiedades y conexiones del proyecto intactas. Quitar elimina el registro y su único registro de rollback, pero no borra contenido del proyecto.

Revocar una capacidad elimina su concesión local y primero invalida todas las leases de esa extensión; después invoca los callbacks de terminación registrados. Un error del callback no devuelve autoridad. La prueba registra una lease sintética e inyecta su callback por el límite privado del host. A3 todavía no lanza un proceso de extensión, por lo que no se afirma terminación real de procesos.

## Alcance de integridad y límites

Esta etapa gestiona **solo el manifiesto**. Comprueba el SHA-256 de sus bytes importados y el hash canónico de sus campos validados. El hash `entrypoints.main.sha256` sigue siendo una declaración: A3 no importa ni verifica aquí el archivo ejecutable. El staging contiene el manifiesto y nunca ejecuta, importa, extrae ni evalúa el entrypoint. La cadena de licencia se muestra y requiere confirmación humana; esto no verifica derechos legales ni la identidad de quien publica el paquete.

La compatibilidad comprobada es con la versión exacta de API que acepta el perfil actual. A3-043 sigue parcial porque la ejecución de código, el aislamiento real de archivos/red, la terminación de un proceso hostil y una actualización de artefactos ejecutables esperan una sandbox Windows comprobada.

## Verificación

```powershell
npm run typecheck
node --experimental-strip-types --experimental-transform-types --test apps/desktop/test/extension-host.test.mjs
npm run build
npm run test:extensions:smoke --workspace @a3/desktop
```

Los fixtures E6 incluyen la extensión hostil 1.0.0 y la actualización 1.1.0, que cambia licencia declarada y amplía el scope de lectura. Las pruebas cubren consentimiento, compatibilidad/versionado, staging, fallo antes de activar, rollback, conservación de bytes del proyecto, migración diferida de estado 1.0, revocación de lease y preservación de aprobaciones durante una actualización fallida.
