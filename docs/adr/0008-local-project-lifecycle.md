# ADR 0008: ciclo local de proyectos y bootstrap sin manifiesto

Estado: aceptada para la implementación E1-F1. Fuente: especificación maestra local §§7–9, 21, 28 y A3-001–003; esquemas E0 y servicios E1.

El proceso principal selecciona las carpetas mediante el diálogo del sistema. El renderer envía acciones, nombre e IDs opacos de preview/sesión; no elige una ruta de acceso por IPC ni recibe el broker. Un proyecto desconocido necesita una concesión local del perfil Proponer. El diálogo de aprobación muestra la carpeta canónica; una solicitud de política del proyecto no concede permisos.

El writer normal necesita manifiesto para identificar el proyecto. Para resolver la creación se añade un bootstrap acotado en `project-store/projects.ts`, usando el mismo arbitraje Windows, entradas `WriteIntent`, `ProgressLog`, staging independiente y publicación exclusiva mediante hardlink que D1. Todos los destinos son nuevos, el conjunto inicial se valida con dominio y codecs, y el manifiesto se instala al final. Los directorios pueden quedar vacíos tras una reversión; el lote conserva `atomic: false` y no anuncia tolerancia a corte eléctrico.

La exclusión `.a3/.gitignore` es un prerrequisito no destructivo y aparece en el preview: se crea antes del journal y permanece tras rollback para proteger `/local/`. Una exclusión distinta ya existente produce conflicto; no se sobrescribe.

Antes de crear metadatos, el host conserva fuera del proyecto una intención de inicialización con identidad de carpeta y los Project/Workspace iniciales. Esto permite localizar el journal aunque el manifiesto todavía no exista. Al volver a abrir, D1 confirma un lote completamente aplicado o revierte uno parcial sin escrituras externas; tras revertir se ofrece una nueva preview. Evidencia ambigua o contenido posterior bloquea la operación. Se corrige en D1 la clasificación de la ausencia restaurada de un archivo que no existía antes: debe coincidir con el candidato preservado, y una recreación externa sigue siendo conflicto.

Se adopta un catálogo de hasta 30 recientes en `userData/local-projects/projects.json`, fuera de datos portables, con IDs, nombres, rutas y fecha. No contiene credenciales ni concesiones. El catálogo tiene propietario único Windows y reemplazo local desde temporal sincronizado; un JSON corrupto se conserva y diagnostica. Electron reutiliza la ventana de la instancia principal. No se usa el catálogo como fuente canónica de nombres, ni como permiso de lectura.

Cada apertura emite una sesión nueva. Las modificaciones de nombre pasan por el dominio y el writer; su borrador vive temporalmente en el host ligado a esa sesión. Cerrar o cambiar primero guarda ese borrador y espera la cola del writer; un fallo mantiene la sesión abierta. El cierre puede solicitar confirmación si hay cambios externos o recuperación pendiente. Un ID de sesión anterior nunca puede editar el proyecto nuevo.

Git es independiente del ciclo local. Este corte mantiene las acciones Git no disponibles conforme al broker E1-E1 y la evidencia E0-C2. No ejecuta `git init`, no crea remotos ni publica. La futura inicialización opcional debe ser una acción explícita con rama `main`, usando un adaptador Git comprobado; no se habilita un proceso arbitrario para simularla.
