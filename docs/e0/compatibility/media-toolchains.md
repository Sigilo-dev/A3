# E0-D3: procesamiento local de imágenes, audio y video en Windows

Prueba ejecutada el 2026-10-14 en Windows 10 x64, build 19045, Node.js 24.13.1 y una CPU AMD Ryzen 7 3700X de 16 hilos lógicos con 32 GiB de RAM. Se consultaron en esa misma fecha las versiones y documentos oficiales citados abajo. El alcance sigue la sección 23 de la especificación maestra y el [contrato de recursos E0-A](../contracts/domain.md): un `Resource` identifica el archivo, su ubicación y la revisión del descriptor; esa revisión no certifica los bytes del archivo. El spike compara hashes de las fuentes sintéticas y no registra recursos en un proyecto A3.

El repositorio y `origin` se verificaron antes de editar: `https://github.com/Sigilo-dev/A3`, rama `codex/e0-foundation`, estado limpio. No se instaló ni actualizó software global. FFmpeg/ffprobe ya estaban instalados; Sharp y su binding nativo se instalaron solo en `experiments/e0/media/` con `npm ci` y lockfile. No se copiaron binarios a Git. Ninguna fuente del usuario se leyó, sustituyó o borró: todos los medios se generaron dentro del arnés.

## Herramientas y licencias observadas

| Componente | Versión/artefacto comprobado | Licencia y procedencia |
|---|---|---|
| Sharp | `sharp@0.35.5`, Apache-2.0; Node.js requerido por upstream: >=20.9.0. La versión estable más reciente publicada que se encontró fue 0.35.5. | Instalación local fijada por `package-lock.json`. La instalación Win x64 trae `@img/sharp-win32-x64@0.35.5`, con licencia declarada `Apache-2.0 AND LGPL-3.0-or-later`; su paquete contiene `libvips-42.dll`, `libvips-cpp-8.18.7.dll` y el addon `.node`. `sharp.versions` reportó libvips 8.18.7. Integridades npm exactas en `toolchain.lock.json`. |
| Dependencias nativas de Sharp/libvips | La lista de versiones registrada incluye libheif 1.23.5, libaom 3.15.1, libwebp 1.6.0, mozjpeg, libtiff, libpng y otras. | El aviso del paquete `sharp-libvips` v1.3.4 incluye dependencias bajo LGPLv3, MPL 1.1, BSD, MIT, libpng, zlib, licencias de FreeType/fontconfig, IJG y la licencia de patentes de AOM. El código upstream de libvips declara LGPL-2.1-or-later; el paquete binario Windows tiene la expresión de licencia combinada indicada arriba. Una distribución tendría que conservar los textos/licencias y avisos de cada componente, y respetar las condiciones LGPL aplicables. El spike no redistribuye esos binarios. |
| FFmpeg/ffprobe | Existían como `Gyan.FFmpeg 8.0.1`, variante `full_build` estática Win x64 instalada con WinGet. `ffprobe` reportó la misma versión y configuración. `winget list` mostró 9.0.2 como versión disponible; la página de builds de Gyan también señalaba 9.0.2 como última release. No se actualizó el equipo. | `ffmpeg -L` informó GNU GPL versión 3 o posterior; `-buildconf` incluye `--enable-gpl`, `--enable-version3` y `--enable-static`, y no incluye `--enable-nonfree`. La página de Gyan declara sus builds estáticas como GPLv3. La configuración activa libx264, libx265 y libmp3lame entre muchas bibliotecas. Para este ejecutable `ffmpeg.exe` y `ffprobe.exe` medí SHA-256 `74db6c…abef93` y `55bb6c…54161c`; el lock también guarda el URL y SHA-256 del ZIP de la versión WinGet. No descargué el ZIP ni comparé sus bytes con los ejecutables ya instalados. |

La GPL aplica a esta build concreta; no se debe reemplazar ese dato por “FFmpeg es LGPL”. El proyecto FFmpeg describe LGPL-2.1-or-later como licencia base, pero indica que activar código GPL cambia la licencia de FFmpeg a GPL. Su documentación también identifica libx264/libx265 como bibliotecas GPL. La página de x264 describe su licencia de software abierta GPLv2 y LAME describe su codificador como LGPL; esas bibliotecas y sus avisos siguen requiriendo revisión por versión al distribuir la build. El buildconfig completo y `-L` están registrados en [results.json](../../experiments/e0/media/results.json). No se completó el inventario de licencia de todas las bibliotecas incluidas en el paquete full ni se resolvió el análisis de patentes de códecs.

Antes de empaquetar FFmpeg en A3 hay que elegir una build concreta y preparar su texto de licencia, avisos de terceros, fuente correspondiente a los binarios, configuración de compilación y cualquier modificación, además de evaluar la combinación de licencias de las bibliotecas externas. La fuente de FFmpeg publicada con la release de Gyan no sustituye el inventario de las fuentes y avisos de esas bibliotecas. El Spike no concede autorización legal para redistribuir la build probada.

## Pruebas de imagen

El arnés genera un patrón RGBA de 32×24 píxeles y archivos PNG, JPEG y AVIF sintéticos; también crea un GIF animado de dos páginas mediante el FFmpeg existente. Todos quedan dentro de `.work/run-*`, directorio ignorado de cada ejecución. Las fuentes conservaron sus hashes durante conversiones. La metadata de AVIF aparece como `format: heif`, `compression: av1`; no es una confusión con HEIC. La fuente PNG tiene alpha, y la salida PNG, WebP, AVIF, TIFF y GIF lo conservó. JPEG se aplanó sobre fondo blanco y quedó sin alpha.

| Operación sobre muestra pequeña | Salida observada | Tamaño/tiempo de esta máquina |
|---|---|---|
| Crear miniatura 16×12 desde PNG 32×24 | WebP; metadata de dimensiones correcta | 192 B / 6.50 ms |
| PNG → PNG | PNG RGBA con alpha | 2,336 B / 10.28 ms |
| PNG → JPEG | JPEG RGB, alpha aplanado | 650 B / 5.98 ms |
| PNG → WebP | WebP RGBA con alpha | 432 B / 5.60 ms |
| PNG → AVIF | AV1, alpha presente | 624 B / 13.50 ms |
| PNG → TIFF | TIFF RGBA con alpha | 546 B / 5.14 ms |
| PNG → GIF | GIF estático con alpha | 1,607 B / 19.27 ms |

Se escribió EXIF sintético en un JPEG de prueba: Sharp quitó EXIF al convertir con opciones predeterminadas y lo conservó al solicitar `keepExif()`. El archivo de entrada no cambió. Sharp decodificó metadata de PNG, JPEG, AVIF y GIF sintéticos. Un archivo de bytes no reconocidos fue rechazado con `Input file contains unsupported image format`. Los formatos de entrada/salida reportados por `sharp.format` y la metadata observada están en el JSON de resultados.

Sharp no anuncia entrada ni salida PDF (`sharp.format.pdf` indica ambos `false`); no se probó creación de PDF con `pdf-lib`. La conversión de imagen a PDF permanece como responsabilidad separada. Aunque se detectaron dos páginas en el GIF sintético y se logró producir una salida GIF estática, no se comprobó conservar animación, temporización ni cada frame.

## Pruebas de audio y video

FFmpeg generó un WAV PCM de dos segundos y un MKV sintético de 160×90 y dos segundos, con video FFV1 y audio PCM. Desde esos archivos generó perfiles con códecs explícitos; `ffprobe -show_streams -show_format -of json` comprobó contenedor y streams, y luego FFmpeg decodificó cada salida hacia el muxer nulo sin error.

| Perfil probado | Códecs comprobados por ffprobe | Tamaño/tiempo |
|---|---|---|
| MP4, marca `isom` | H.264 Constrained Baseline + AAC LC | 63,417 B / 100.89 ms |
| MOV, marca `qt` | H.264 Constrained Baseline + AAC LC | 63,468 B / 98.04 ms |
| Matroska/MKV | H.264 Constrained Baseline + FLAC | 62,704 B / 60.77 ms |
| MP3 | `libmp3lame`, stream MP3 | 8,912 B / 61.62 ms |
| FLAC | encoder FLAC nativo de esta build | 32,434 B / 58.95 ms |

MP4 y MOV comparten el demuxer/muxer family `mov,mp4,m4a,3gp,3g2,mj2`; la marca mayor diferenciada fue `isom` y `qt`. Esto demuestra solo esos perfiles de salida con esos streams y esta build. No demuestra que cada archivo con extensión MP4/MOV/MKV, cámara, resolución, perfil H.264, profundidad de color, subtítulos o pista múltiple sea compatible. No se probaron salida WebM/OGG/WAV, remux, HEVC, aceleración por hardware ni conversiones desde muestras de terceros. MP3 y FLAC de salida no convierten pérdidas en calidad recuperada.

Se generó un medio sintético no reconocido: ffprobe terminó con código 1 y `Invalid data found when processing input`. Para cancelación, el arnés ejecutó una transcodificación en bucle en tiempo real, la terminó a los ~0.9 s, observó un parcial temporal, quitó solo ese parcial y verificó que el hash del MKV sintético de origen siguiera igual. Esto prueba terminación del proceso y limpieza de su temporal de prueba. No prueba la cola, UI, cancelación cooperativa, transacción, recuperación tras reinicio ni reemplazo de Resource en A3.

Todos los tamaños y tiempos anteriores describen estos archivos minúsculos en el Ryzen de este host; no son objetivos ni estimaciones para otros equipos o medios. La ejecución detallada, tiempos exactos y versiones de cada biblioteca están en [results.json](../../experiments/e0/media/results.json). Para reproducir: desde `experiments/e0/media/`, ejecutar `npm ci` y `npm test`. Cada ejecución crea una nueva carpeta sintética `.work/run-*`; se puede borrar `.work/` de este spike cuando no haya Node ejecutándose. FFmpeg se descubre desde PATH y el script no descarga/instala FFmpeg.

## Relación con A3 y próximos límites

- **A3-025, Galería:** no se implementó galería ni catálogo de Resources, filtro por grupo/colección, orden de imágenes y videos, ni navegación entre representaciones. Solo se comprobaron metadata de muestras locales; el criterio sigue pendiente.
- **A3-039, Imágenes:** el spike ejecutó entrada PNG/JPEG/AVIF, miniaturas, salida PNG/JPEG/WebP/AVIF/TIFF/GIF, transparencia, EXIF y rechazo de entrada no soportada. Es evidencia parcial de capacidad del paquete fijado, no de importación/exportación de A3. PDF no fue probado y no es una salida de Sharp.
- **A3-040, Audio/video:** se comprobaron salidas MP4(H.264/AAC), MOV(H.264/AAC), MKV(H.264/FLAC), MP3 y FLAC, con ffprobe y decodificación del resultado; también una cancelación de proceso aislada. Es evidencia de esos cinco perfiles en Gyan 8.0.1, no de compatibilidad general de contenedores/códecs ni del flujo de trabajos de A3.

Para producto, la capacidad debe ser una matriz de perfiles de entrada/salida y codificadores disponibles en la build concreta. Si falta uno, mostrar “Componente requerido” o deshabilitar ese perfil. Las conversiones deberían crear un archivo nuevo y un Resource nuevo, conservar los bytes del original y promover salida temporal solo después de verificarla; “reemplazar” exige una operación posterior recuperable. No habilitar un formato basándose solo en la extensión o en que exista un wrapper npm.

Fuentes oficiales y primarias, consultadas el 2026-10-14:

- [Sharp installation: binarios por plataforma, Node.js y formatos](https://sharp.pixelplumbing.com/install/), [formatos de salida](https://sharp.pixelplumbing.com/api-output/) y [metadata de entrada](https://sharp.pixelplumbing.com/api-input/).
- [Release Sharp 0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5), [metadata npm Sharp 0.35.5](https://registry.npmjs.org/sharp/0.35.5), [libvips upstream license](https://github.com/libvips/libvips) y [avisos nativos sharp-libvips v1.3.4](https://github.com/lovell/sharp-libvips/blob/v1.3.4/THIRD-PARTY-NOTICES.md).
- [FFmpeg License and Legal Considerations](https://ffmpeg.org/legal.html), [FFprobe documentation](https://ffmpeg.org/ffprobe.html) y [FFmpeg encoders documentation](https://ffmpeg.org/ffmpeg-codecs.html).
- [Gyan FFmpeg builds: variantes, versión y licencias](https://www.gyan.dev/ffmpeg/builds/), [release Gyan 8.0.1](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1) y [manifest WinGet Gyan.FFmpeg 8.0.1](https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/Gyan/FFmpeg/8.0.1/Gyan.FFmpeg.installer.yaml).
- [Licencia de x264](https://x264.org/licensing/) y [sitio oficial LAME](https://lame.sourceforge.io/about.php).
