# E1-F2: explorador de archivos del proyecto

Relaciona los criterios A3-002 y A3-024. El explorador trabaja sobre la carpeta local A3 abierta en el host Electron; no introduce una segunda copia del catálogo ni adopta rutas como identidad de elemento.

## Navegación y seguridad

- El host enumera una carpeta por vez y devuelve páginas de hasta 100 entradas. La interfaz carga las subcarpetas al abrirlas y permite continuar con la página siguiente. Los archivos se identifican con UUID opacos ligados a la sesión, ruta relativa y huella del archivo; una ruta mostrada no funciona como ID.
- `.a3` (incluido `.a3/local`), `.git`, `node_modules`, archivos de credenciales/secretos y los elementos excluidos por reglas `.gitignore` compatibles con el lector actual quedan fuera de la lista normal. Las reglas ignoradas dentro de una carpeta impiden renombrar, duplicar o enviar esa carpeta a la papelera en conjunto, para no afectar datos omitidos.
- Los symlinks, junctions y archivos especiales no se siguen. Un enlace detectado se muestra como bloqueado y no admite abrir, copiar ruta, renombrar, duplicar ni borrar. Las rutas vuelven a validarse en el host antes de abrir o escribir; se comprueban la identidad del elemento, el conflicto externo y la identidad de las carpetas involucradas.
- Las referencias `mounted-file` aparecen en un apartado separado. Se comprueban tanto la concesión local de lectura como la raíz y el archivo relativo aprobado. Las referencias siguen siendo de solo lectura y el proyecto clonado no hereda la concesión. Una raíz o archivo ausente conserva el descriptor y se muestra desconectado.

## Acciones y datos

Crear archivo/carpeta, renombrar, duplicar y enviar a papelera usan el escritor del proyecto y el journal D1. Renombrar actualiza la ruta del recurso conservando su ID; duplicar crea IDs independientes. La papelera es local y recuperable en `.a3/local/trash`; no es una eliminación permanente. La vista previa de borrado vuelve a comprobar usos y permiso antes de ofrecer confirmación; si otro elemento usa un recurso, la UI muestra esos usos y bloquea el borrado. La capacidad `delete` no se concede por defecto, así que primero puede requerir una concesión local explícita.

La creación de carpetas vacías usa un marcador interno oculto `.a3-folder.json`. Al renombrar o enviar a la papelera una carpeta, los bytes y marcadores participan en el journal; después se intenta retirar las carpetas vacías de origen. Esa limpieza de directorios es de mejor esfuerzo: una interrupción puede dejar directorios vacíos, sin perder los archivos recuperables.

Abrir un archivo muestra una vista previa de texto UTF-8 de hasta 2 MiB; los binarios se identifican por tamaño y tipo, sin decodificar como texto. Esta etapa no implementa edición de contenido desde el explorador. El portapapeles recibe la ruta absoluta o relativa solo tras autorización del broker; la interfaz no obtiene una ruta absoluta para utilizarla como identidad.

## Comprobaciones

Las pruebas `packages/project-store/test/explorer.test.mjs` cubren paginación, exclusiones, IDs separados de rutas, copia de rutas, creación, renombrado con resource ID estable, duplicación con ID nuevo, cancelación de borrado, denegación por perfil y mounts ausentes. Las pruebas de montajes E1-E2 cubren traversal y junctions. La prueba de humo Electron comprueba navegación por teclado, apertura, renombrado, duplicación, cancelación del borrado, IPC acotado, aislamiento del renderer y sesiones obsoletas.

En Windows se verificó `npm test`, `npm run build --workspace @a3/desktop` y `npm run test:desktop`. Esto no valida instalador de publicación ni la durabilidad ante corte eléctrico.
