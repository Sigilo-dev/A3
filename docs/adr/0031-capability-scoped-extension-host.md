# ADR 0031 — host local de extensiones con ejecución deshabilitada

Estado: aceptada para el subconjunto preventivo E6-E1. Base: A3 §§21/24.4, contrato E0 de extensiones, E0-C2 y E5-E2. Criterio A3-043 parcial.

## Decisión

Se añade el perfil `programmed-extension`, separado del manifiesto declarativo E0/E6-D2. Declara entrypoint y hash, permisos independientes `project.read`, `document.edit`, `network.access`, `process.run` y un scope obligatorio para cada permiso. Lectura/escritura usan IDs de recurso; red usa orígenes HTTPS exactos; procesos usan IDs de ejecutables, nunca comandos o rutas arbitrarias. Esos scopes son solicitudes, no concesiones.

El host guarda únicamente manifiestos revisados y aprobaciones locales, fuera del proyecto, ligados a raíz canónica, identidad del directorio, UUID del proyecto y hash del contenido canónico del manifiesto. La revisión muestra también el hash de los bytes importados. Una actualización requiere preview y confirmación nativa, desactiva la extensión y elimina todas las aprobaciones anteriores. La misma versión es inmutable. Las aprobaciones se registran por capacidad y pueden ser más estrechas que lo solicitado. Ninguna aprobación es efectiva mientras falte la sandbox; tampoco confiere permisos del proyecto. Un clon no hereda el estado local.

El renderer local dispone solo de IPC de configuración validado. Páginas remotas, otros WebContents, plugins y agentes no reciben ese puente ni una referencia al broker. No existe un dispatcher de herramientas de extensión habilitado. La validación lógica de invocaciones es un contrato preventivo por ID; superarla no autoriza IO. Un futuro runtime necesitará identidad autenticada propia e intersección de manifiesto, concesión de extensión, broker de proyecto, scope y aislamiento demostrado por capacidad.

## Frontera comprobada

La repetición de E0-C2 en Windows 10 confirmó nuevamente que un proceso Node ordinario puede acceder fuera de la raíz lógica y conservar ese acceso tras revocación. No hay launcher AppContainer/token restringido ni Job Object probado. Por ello todas las capacidades de ejecución de extensiones se anuncian no disponibles y `start` falla antes de abrir el entrypoint. No se ejecuta código en Node, workers, VM ni renderer como sustituto.

Desactivar/revocar/actualizar invalida primero las sesiones del registro host. Revocaciones del broker y cambio de proyecto invalidan también previews y aprobaciones en curso. Los hooks de terminación son preventivos y están probados con callbacks sintéticos; no certifican terminación de un árbol real. Un callback que falle no recupera la autoridad revocada. Actualmente no se crea ningún proceso de plugin.

## Consecuencias

La interfaz permite revisar manifiestos, comparar scopes, registrar aprobaciones locales aún inefectivas, revocar, desactivar y quitar el registro. Guardar este metadato no instala un paquete ejecutable. Datos del proyecto y lock de nodos declarativos no cambian. Registros locales corruptos se diagnostican y no se sobrescriben; decisiones se auditan sin contenido, credenciales, scopes ni rutas absolutas. El almacenamiento local no es una defensa frente a otro proceso del mismo usuario del SO ni promete durabilidad ante corte eléctrico.

A3-043 no queda aceptado para ejecución positiva, contención real de archivos/red, actualización de código ni terminación de procesos hostiles. Esas capacidades requieren evidencia Windows nueva antes de habilitarse.

## E6-E2 — ciclo de vida sin ejecución

Las actualizaciones del manifiesto usan preview, revisión de licencia/scopes, staging local con hash verificado y activación por reemplazo atómico del registro local. Se conserva una versión previa para rollback; tanto la versión actualizada como la restaurada quedan desactivadas y sin concesiones. Un fallo antes de activar conserva el registro anterior. Desactivar y revocar invalidan leases primero; los callbacks de terminación son una interfaz de host probada con fixtures, no evidencia de un proceso real. El detalle reproducible está en [E6-E2](../e6/extension-lifecycle.md).

Este ciclo no instala ni valida el hash del archivo ejecutable: el contrato de entrada disponible es el manifiesto JSON. La cadena de licencia se valida como dato requerido y la persona confirma su revisión, pero A3 no acredita derechos legales. A3-043 sigue parcial hasta verificar un sandbox Windows y el artefacto de extensión completo.
