# E2-F2 · enlaces, menús y atajos

Base: `3c09828` (Markdown y focus aceptados), rama `codex/e2-canvas`. Especificación §§9, 12, 25; contratos E0-A y límites E0-C2/D1. [ADR 0012](../adr/0012-contextual-navigation.md).

## Uso

- Desde una página focus, pulsa un wikilink o enlace Markdown visual, o una entrada de Enlaces salientes/Backlinks. El índice devuelve ID y ancla; ante nombre ambiguo se muestran título, ruta e ID para elegir. Los enlaces externos solo se describen; no se abre red automáticamente.
- El selector abre páginas por identidad. «Crear vínculo por identidad» permite copiar `[[UUID|Título]]` y pegarlo en el documento. «Volver» y «Avanzar» reutilizan pestañas. Un fragmento abre modo fuente en su ubicación; guarda un borrador antes de aplicar offsets indexados.
- Clic derecho o Shift+F10 sobre pestaña/página ofrece apertura, otra vista, vínculo por ID, renombrado transaccional, movimiento por ruta relativa validada, referencia y cierre. Cerrar no borra contenido. Los cambios afectan a las referencias únicas conocidas del proyecto; el resto de sintaxis permanece intacto.
- Canvas/placement/grupo/trazo ofrecen las acciones ya implementadas de inserción, pegado, dibujo, ajuste, apertura de página, duplicación, agrupación, bloqueo, organización y borrado de trazos, según contexto. Un grupo puede renombrarse, contraerse/expandirse o desplazarse. El ajuste incluye geometría persistida, además del fixture opcional.
- Archivo/carpeta ofrece abrir, editor de código cuando procede, renombrar/mover con referencias, duplicar, copiar rutas, papelera con revisión de usos y creación dentro de carpetas. Se mantienen los controles de identidad, raíces, permisos y conflictos del explorador. No se añaden conversiones, Git ni diagramas posteriores.
- Preferencias contiene los atajos de las operaciones disponibles: guardar, cerrar pestaña, volver/avanzar, undo/redo de canvas, duplicar, agrupar, ajustar, borrar trazos/líneas y renombrar/duplicar/papelera de archivos. Es posible desactivar un atajo, cambiarlo, detectar colisiones y restaurar defaults. Los atajos nativos del editor se mantienen.

## Verificación y límites

Pruebas temporales Windows de resolución de alias/IDs/heading/block, ambigüedad, fuentes CRLF/BOM y sintaxis desconocida, enlaces Markdown inline/de referencia, actualización de referencias en rename/move y reinicio del índice, revisión obsoleta, conflicto externo antes de commit, revocación del broker, corrupción localizada y persistencia/restauración de atajos. El recorrido real de Electron usa perfil temporal, red bloqueada y portapapeles sustituido por un adaptador de prueba; no lee ni reemplaza el portapapeles de la persona. Comprueba navegación, menús por los siete contextos, permiso denegado y límites del IPC entre ventanas.

```sh
npm test
npm run build
npm run test:focus --workspace @a3/desktop
npm run test:navigation --workspace @a3/desktop
npm run test:smoke --workspace @a3/desktop -- --editors-only
```

El índice no sustituye a los archivos y se puede reconstruir; no hay base de backlinks portable. El historial de visitas vive en la sesión actual. El índice de páginas no es un índice de todos los archivos ni actualiza referencias desconocidas de plugins, imágenes o nombres ambiguos. Los montajes requieren su concesión local previa, y sus bytes no se reescriben. Una operación que requiere modificar una referencia montada se rechaza completa. No se certifican sintaxis arbitraria, offsets de borradores pendientes, durabilidad física frente a corte eléctrico, Linux, instalador ni todas las preferencias de A3-044/A3-052.
