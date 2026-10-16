# E2-B2: grupos espaciales

Los grupos son documentos locales a un workspace y solo contienen referencias a placements, trazos y otros grupos. No copian entidades, recursos ni archivos. Las colecciones del proyecto siguen agrupando entidades por separado y no se modifican al agrupar elementos del lienzo.

`members` sigue siendo la fuente de pertenencia. La propiedad opcional `collapsed` guarda el estado de presentación y conserva compatibilidad con grupos E1 que todavía no la incluyen. Un grupo antiguo sin ese campo se abre expandido. Las propiedades desconocidas en documentos o miembros permanecen preservadas por los codecs y los comandos del dominio.

El dominio valida que todos los miembros existan en el mismo workspace y rechaza los ciclos. Incluir y sacar elementos actualiza la lista de miembros mediante comandos con revisión. Mover un grupo aplica el desplazamiento una sola vez a cada placement y a cada punto de trazo alcanzable, incluso si un placement aparece por más de una rama. El contenido global de las entidades no cambia; los placements bloqueados conservan su posición según la regla existente de bloqueo.

Al contraer, el renderer oculta temporalmente los miembros y muestra una tarjeta con el nombre y el recuento. Al expandir, vuelve a calcular el marco desde las posiciones persistidas, sin escribir nuevas coordenadas. Las aristas visuales conservan los placement IDs canónicos en disco; durante el render, los extremos que quedan ocultos apuntan al grupo contraído más cercano. Esa proyección no crea relaciones semánticas.

Crear, renombrar, incluir, sacar, mover y contraer/expandir pasan por el broker y el escritor del proyecto. Una revisión obsoleta produce conflicto y el renderer recarga el estado confirmado en lugar de imponer su copia local.
