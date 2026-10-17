# E3-G3 · conversión local de audio y video

Implementa el subconjunto comprobado de §§23.1/23.3–23.4 y A3-040 sobre Resource E0-A, broker y escritor/journal E1. Se conserva la distinción entre contenedor y códec: el MIME/nombre del descriptor no decide la inspección. La fuente se abre por ID mediante el host, nunca mediante una ruta proporcionada por el renderer.

## Componente opcional y licencia

Se conserva la build comprobada en [E0-D3](../e0/compatibility/media-toolchains.md): Gyan FFmpeg/ffprobe **8.0.1 full_build, Windows x64**, estática, GPL-3.0-or-later. Se verifican `--enable-gpl`, `--enable-version3`, `--enable-static`, ausencia de `--enable-nonfree`, versión de ambas herramientas, licencia informada y encoders necesarios. Los SHA-256 admitidos son:

| Ejecutable | SHA-256 |
|---|---|
| ffmpeg.exe | `74db6c184a03dba2bdfe23e1a1f41cf5a8385bc1de6a7a1b26db1dc541abef93` |
| ffprobe.exe | `55bb6c6289367ae2383efa86b26bf2596f8adb72ac747360eb13df162354161c` |

Una instalación nueva de A3 muestra «Componente requerido». La persona elige configurar el motor y selecciona su carpeta `bin` mediante diálogo nativo, después de ver versión, procedencia, GPL y aislamiento disponible. No se acepta una ruta de ejecutable por IPC ni desde el proyecto. No hay búsqueda/ejecución automática en PATH, descarga, instalación global ni binarios FFmpeg en el paquete A3. La selección queda en `userData/media-engines/ffmpeg/engine.json`, fuera del proyecto. Cada lanzamiento vuelve a comprobar archivo regular, ruta canónica e integridad de su ejecutable; una actualización de FFmpeg distinta queda deshabilitada hasta revisar un nuevo perfil/hash. El arnés de pruebas sí descubre PATH para localizar la build de E0 y comprueba sus hashes.

Esta build no es MIT ni LGPL solamente. Su selección local no completa el inventario de licencias de todas las bibliotecas ni autoriza redistribuirla. No se afirma un instalador de publicación listo. Véanse [licencia oficial](https://ffmpeg.org/legal.html), [build Gyan 8.0.1](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1) y el lock de E0-D3. No se modifican dependencias npm ni su lockfile.

## Matriz habilitada

| Perfil | Video | Audio | Comprobación adicional |
|---|---|---|---|
| MP4 | libx264, H.264 Constrained Baseline, YUV420p/8 bits, 30 fps | AAC | Marca `isom` |
| MOV | Igual a MP4 | AAC | Marca `qt` |
| MKV | Igual a MP4 | FLAC, 16 bits | Contenedor Matroska |
| MP3 | Sin video; permite extracción | libmp3lame / stream MP3 | Una pista de audio |
| FLAC | Sin video; permite extracción | FLAC, 16 bits | Una pista de audio |

Los cinco perfiles se comprueban con procesos reales desde el fixture FFV1+PCM MKV, y MP3/FLAC además desde WAV PCM. También se prueba FLAC→MP3. MP4/MOV se producen fragmentados por pipe; se advierte que la compatibilidad con reproductores puede variar. No hay remux ni salidas WebM/WAV/OGG, HEVC, aceleración de hardware o descarga de YouTube.

La verificación comprueba 30 fps nominales (`r_frame_rate`), AAC LC, 48 kHz/estéreo y FLAC de 16 bits. No confunde el promedio `avg_frame_rate` con esa tasa: en el fixture MP4/MOV corto el priming de AAC y el contenedor fragmentado dan un promedio distinto, que se conserva en la inspección.

La entrada está restringida por firma y por listas de demuxers/decoders: familia MOV/MP4, Matroska, WAV, MP3 y FLAC; video H.264/FFV1 y audio PCM s16le/AAC/MP3/FLAC. Se exige una pista de audio y, opcionalmente, una de video, sin subtítulos/adjuntos/pistas extra; hasta 1920×1080, 60 fps y audio mono/estéreo hasta 48 kHz. Un video sin audio u otro códec se diagnostica como fuera de matriz. No se garantiza compatibilidad con todos los archivos que tengan esas extensiones. Una duración conocida mayor de diez minutos se rechaza; cuando el pipe no informa duración, el progreso es indeterminado y siguen aplicándose límites de bytes/tiempo. No se inventa una duración ni tamaño estimado.

Dimensiones de salida pares de 2×2 a 1920×1080, CRF 18–35 y audio a 96/128/192/256/320 kbps cuando corresponde. El audio se normaliza a estéreo/48 kHz; FLAC usa muestras de 16 bits. Se informa pérdida de metadatos/capítulos, imagen/HDR/alpha, cambio de proporción, frecuencia, canales y profundidad. FLAC no recupera calidad perdida; no se anuncia como conversión universal sin pérdida.

## Aislamiento y permisos efectivos

El procesamiento ocurre en procesos auxiliares del host; no en React, workers del renderer ni webviews. `spawn` usa `shell:false`, ejecutable verificado y argumentos construidos exclusivamente por el adaptador. El hijo recibe medios por stdin/stdout, progreso por un pipe separado y una carpeta temporal sin rutas del proyecto. Se limita la entrada a protocolo `pipe`, demuxers y decoders fijados; se rechazan playlists, scripts, documentos y URLs. El entorno no hereda tokens, cookies o claves: solo sistema Windows, TEMP/TMP local, idioma y zona horaria. No se aceptan filtros, includes, parámetros, comandos ni plugins arbitrarios.

Límites de aplicación: 32 MiB por entrada/salida; máximo 16 pistas en la inspección y solo 1–2 admitidas para convertir; inspección 15 s, proceso 120 s, salida JSON 512 KiB, stderr 128 KiB, `max_alloc` 64 MiB por asignación y un hilo de decodificación/codificación/filtros. **Esto no es una sandbox de Windows ni un límite total de RAM/CPU del SO.** Los procesos conservan los derechos del usuario; las listas de protocolos limitan el flujo implementado y no contienen una vulnerabilidad nativa. Tampoco se garantiza resistencia contra la sustitución del binario por otro proceso del mismo usuario entre hash y ejecución. No se habilita `process.run`, red, instalación de paquetes ni comandos de agentes.

Se añade `media.convert` como capacidad específica: Consultar la deniega, Proponer pide aprobación local, Trabajar la admite y Personalizado permite concesión/revocación individual mediante el broker. Un `policies.json` importado no otorga nada. Se autoriza antes de inspeccionar, convertir y confirmar. Lectura exige además `project.read`, y una fuente montada exige binding local/`mount.read`; no se escribe en ella. El escritor exige `document.edit` y `media.convert` para el nuevo Resource audiovisual, incluida la comprobación al aplicar. Revocar afecta la siguiente operación; no se finge revocar retroactivamente un proceso ya autorizado/en curso. La auditoría registra capacidades/acción sin bytes de medios ni secretos.

## Trabajos, staging y confirmación

Estados: inspeccionar → inspeccionado → cola → convirtiendo → verificando → staging → confirmando → creado; error/conflicto/cancelado son resultados explícitos. La cola host permite un trabajo AV a la vez, independiente de los dos workers de imagen existentes. El límite es configurable en el constructor host (1–4), con valor de producto 1; no se declara implementada una pantalla general de preferencias de colas. Hasta 16 trabajos por diálogo, con configuración/resultado propios. Galería permite seleccionar videos locales por lotes; audio y otros Resources registrados se abren desde el menú de Archivos. Los montajes disponibles ofrecen inspección y conversión a un recurso interno nuevo. YouTube/referencias web no se convierten ni descargan.

La inspección muestra contenedor, códecs reales, dimensiones/fps, canales/frecuencia, bytes y duración disponible. El progreso de FFmpeg nunca alcanza éxito por sí solo: antes de habilitar confirmación se comprueban códecs, número de pistas, contenedor/marca, dimensiones, pixel format/perfil y duración cuando está disponible, y se decodifica la salida completa con rechazo de errores. Un exit fallido, timeout, cancelación, bytes excesivos, inspección o decodificación fallida descarta el parcial.

El staging vive en `userData/av-conversion-staging/job-*`, fuera del proyecto. La salida y el descriptor no aparecen en el catálogo hasta «Crear recurso nuevo». El escritor registra archivo nuevo en `assets/converted/`, Resource UUID nuevo y procedencia namespaced `a3.media.conversion` (source ID/revisión/hashes, versión/licencia de motor, parámetros/pérdidas). Se revalidan descriptor/hash de origen, permisos, destino, montajes y cambios externos. La extensión debe coincidir con el perfil; colisiones, aliases Windows/traversal, bytes nuevos del origen o revisiones obsoletas no se sobrescriben. El plan se prepara de nuevo al confirmar para admitir salidas hermanas propias sin ignorar cambios externos.

Cada salida usa la operación lógica recuperable de archivo+descriptor del journal E1; no es atomicidad global del sistema de archivos. Un lote puede tener éxitos y conflictos independientes. Repetir confirmación del mismo job creado devuelve su Resource, sin duplicarlo. Cancelar espera cierre efectivo del proceso antes de liberar el slot, descarta plan/staging y nunca borra la fuente. Si ya comenzó la confirmación, se deja terminar el escritor/journal y no se anuncia una cancelación falsa. Cerrar/cambiar proyecto o salir de A3 cancela y espera pendientes. Los jobs no se reanudan después de reiniciar; un cierre abrupto antes de confirmar puede dejar staging local sin registrar. Una confirmación interrumpida usa recuperación E1. No se probó corte eléctrico físico ni restauración automática de jobs.

## Pruebas reproducibles

- `npm run build --workspace @a3/desktop`: artefactos existentes, tipos y bundles.
- `npm run test:av --workspace @a3/desktop`: hashes/versiones, cinco perfiles nativos, WAV/FLAC, ffprobe y decodificación, firma inválida/truncada, marca errónea, motor ausente/alterado, HTTP/file bloqueados por protocolos, timeout/cancelación real, cola/cancelación pendiente, staging, Resource nuevo/reapertura, colisión, fuente externa cambiada, revocación y fallo de verificación sin parcial.
- `npm run test:av:smoke --workspace @a3/desktop`: Electron real con perfil/proyecto temporal, ausencia inicial de motor, selección nativa, contenedor/códecs, pérdidas, staging y confirmación por UI, cancelación sin huérfanos, IPC estricto y renderer sin Node. El arnés oculta la ventana, no usa medios del usuario.
- `node apps/desktop/scripts/generate-av-fixtures.mjs`: regenera únicamente los fixtures sintéticos de este directorio con el FFmpeg fijado. Matroska genera UIDs variables: el manifiesto registra los hashes de cada regeneración, no promete bytes idénticos de FFmpeg entre ejecuciones.

Los fixtures `fixtures/e3/av/` tienen hashes en `manifest.json`. La evidencia se limita a Windows x64 y estas muestras pequeñas; no acredita Linux, todos los códecs/cámaras, grandes bibliotecas, contención de un exploit nativo ni publicación. La [matriz consolidada E3](evidence.md) mantiene visibles los criterios parciales de etapas anteriores.
