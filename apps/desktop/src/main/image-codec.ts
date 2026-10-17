import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import type { ImageConversionSettings, ImageEngineInfo, ImageInspection, ImageOutputInfo } from '../shared/image-conversion';

export const IMAGE_INPUT_LIMIT = 32 * 1024 * 1024;
export const IMAGE_PIXEL_LIMIT = 40_000_000;
const sourceOptions = { limitInputPixels: IMAGE_PIXEL_LIMIT, failOn: 'warning' as const, sequentialRead: true };
sharp.cache(false); sharp.concurrency(1);

export function imageEngineInfo(): ImageEngineInfo {
  const supported = process.platform === 'win32' && process.arch === 'x64' && sharp.versions.sharp === '0.35.5' && sharp.versions.vips === '8.18.7';
  return { sharp: sharp.versions.sharp!, vips: sharp.versions.vips!, pdfLib: '1.17.1', platform: `${process.platform}-${process.arch}`,
    profiles: (['png', 'jpeg', 'avif', 'pdf'] as const).map((format) => {
      const encoder = format === 'avif' ? sharp.format.heif : format === 'pdf' ? sharp.format.png : sharp.format[format];
      const available = supported && encoder.input.buffer && encoder.output.buffer;
      return { format, available, ...(!available ? { reason: 'Componente Windows x64 o perfil fijado no disponible.' } : {}) };
    }) };
}
export async function inspectImage(bytes: Uint8Array): Promise<ImageInspection> {
  if (!bytes.length || bytes.length > IMAGE_INPUT_LIMIT) throw new Error('IMAGE_INPUT_LIMIT: La fuente debe tener entre 1 byte y 32 MiB.');
  const head = Buffer.from(bytes.subarray(0, 64)), text = head.toString('latin1');
  const rasterSignature = head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    head[0] === 255 && head[1] === 216 && head[2] === 255 || /^GIF8[79]a/.test(text) ||
    text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP' || text.startsWith('II*\u0000') || text.startsWith('MM\u0000*') ||
    text.slice(4, 8) === 'ftyp' && /avif|avis/.test(text.slice(8));
  if (!rasterSignature) throw new Error('IMAGE_INPUT_UNSUPPORTED: Firma de imagen raster no admitida; SVG, HTML y PDF de entrada no se procesan.');
  // Decoder metadata, not the extension or a project-provided MIME type, selects the matrix row.
  const metadata = await sharp(Buffer.from(bytes), sourceOptions).metadata();
  const format = metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format ?? 'unknown';
  const { width, height } = metadata.autoOrient ?? metadata;
  if (!width || !height || width * height > IMAGE_PIXEL_LIMIT) throw new Error('IMAGE_PIXEL_LIMIT: Dimensiones desconocidas o superiores a 40 megapíxeles.');
  const pages = metadata.pages ?? 1;
  const supported = ['png', 'jpeg', 'avif'].includes(format) && pages === 1;
  const warnings: string[] = [];
  if (pages > 1) warnings.push('La fuente tiene varias páginas o animación. Esta matriz no conserva todos los frames y bloquea su conversión.');
  if (!['png', 'jpeg', 'avif'].includes(format)) warnings.push(`La entrada real ${format} está fuera de la matriz validada PNG/JPEG/AVIF.`);
  if (metadata.depth && metadata.depth !== 'uchar') warnings.push('La salida usa 8 bits por canal: se perderá profundidad de color.');
  return { format, width, height, bytes: bytes.byteLength, alpha: metadata.hasAlpha ?? false, pages, depth: metadata.depth ?? 'unknown',
    ...(metadata.orientation ? { orientation: metadata.orientation } : {}), hasMetadata: !!(metadata.exif || metadata.icc || metadata.xmp || metadata.iptc), supported, warnings };
}
export function validImageSettings(value: unknown): value is ImageConversionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 9 && Object.keys(input).every((key) => ['format', 'width', 'height', 'quality', 'transparency', 'background', 'paper', 'orientation', 'marginMm'].includes(key)) &&
    ['png', 'jpeg', 'avif', 'pdf'].includes(String(input.format)) &&
    typeof input.width === 'number' && Number.isInteger(input.width) && input.width >= 1 && input.width <= 16000 &&
    typeof input.height === 'number' && Number.isInteger(input.height) && input.height >= 1 && input.height <= 16000 && input.width * input.height <= IMAGE_PIXEL_LIMIT &&
    typeof input.quality === 'number' && Number.isInteger(input.quality) && input.quality >= 1 && input.quality <= 100 &&
    ['preserve', 'flatten'].includes(String(input.transparency)) && typeof input.background === 'string' && /^#[0-9a-f]{6}$/i.test(input.background) &&
    ['A3', 'A4'].includes(String(input.paper)) && ['portrait', 'landscape'].includes(String(input.orientation)) &&
    typeof input.marginMm === 'number' && Number.isFinite(input.marginMm) && input.marginMm >= 0 && input.marginMm <= 50;
}
export async function convertImage(bytes: Uint8Array, settings: ImageConversionSettings): Promise<{ bytes: Uint8Array; info: ImageOutputInfo }> {
  if (!validImageSettings(settings)) throw new Error('INVALID_IMAGE_SETTINGS: Opciones de conversión inválidas.');
  const source = await inspectImage(bytes), engine = imageEngineInfo();
  if (!source.supported) throw new Error('IMAGE_INPUT_UNSUPPORTED: La fuente real no pertenece a la matriz estática validada.');
  if (!engine.profiles.find((profile) => profile.format === settings.format)?.available) throw new Error('ENGINE_UNAVAILABLE: Perfil de imagen no disponible.');
  const flatten = settings.format === 'jpeg' || settings.format === 'pdf' || settings.transparency === 'flatten';
  const warnings = [...source.warnings, 'La salida se normaliza a sRGB de 8 bits y elimina EXIF/XMP/IPTC y otros metadatos; la orientación EXIF se aplica a los píxeles.'];
  if (source.alpha && flatten) warnings.push('Se pierde la transparencia al aplanar sobre el fondo elegido.');
  if (settings.width !== source.width || settings.height !== source.height) warnings.push('El cambio de dimensiones remuestrea la imagen y puede alterar su proporción.');
  if (settings.format === 'jpeg' || settings.format === 'avif') warnings.push('La codificación elegida es con pérdida; aumentar calidad no recupera información perdida en el original.');
  let pipeline = sharp(Buffer.from(bytes), sourceOptions).autoOrient().toColourspace('srgb').resize(settings.width, settings.height, { fit: 'fill' }).timeout({ seconds: 20 });
  if (flatten) pipeline = pipeline.flatten({ background: settings.background });
  let output: Uint8Array, pageWidth: number | undefined, pageHeight: number | undefined;
  if (settings.format === 'jpeg') output = await pipeline.jpeg({ quality: settings.quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  else if (settings.format === 'avif') output = await pipeline.avif({ quality: settings.quality, effort: 4, bitdepth: 8, chromaSubsampling: '4:4:4' }).toBuffer();
  else {
    const png = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (settings.format === 'png') output = png;
    else {
      const document = await PDFDocument.create(), embedded = await document.embedPng(png);
      const size = settings.paper === 'A3' ? [841.89, 1190.55] : [595.28, 841.89];
      if (settings.orientation === 'landscape') size.reverse();
      [pageWidth, pageHeight] = size as [number, number];
      const page = document.addPage([pageWidth, pageHeight]), margin = settings.marginMm * 72 / 25.4;
      const scale = Math.min((pageWidth - margin * 2) / settings.width, (pageHeight - margin * 2) / settings.height);
      page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(1, 1, 1) });
      page.drawImage(embedded, { x: (pageWidth - settings.width * scale) / 2, y: (pageHeight - settings.height * scale) / 2, width: settings.width * scale, height: settings.height * scale });
      output = await document.save(); warnings.push('PDF contiene una imagen raster en una página blanca con ajuste a página; no vectoriza la fotografía ni conserva transparencia de la página.');
      const verified = await PDFDocument.load(output); if (verified.getPageCount() !== 1) throw new Error('IMAGE_OUTPUT_INVALID: PDF inválido.');
    }
  }
  if (!output.length || output.length > IMAGE_INPUT_LIMIT) throw new Error('IMAGE_OUTPUT_LIMIT: La salida supera 32 MiB. Reduce dimensiones o calidad.');
  let alpha = false;
  if (settings.format !== 'pdf') {
    const verified = await inspectImage(output);
    if (verified.format !== settings.format || verified.width !== settings.width || verified.height !== settings.height) throw new Error('IMAGE_OUTPUT_INVALID: La salida no coincide con el perfil.');
    alpha = verified.alpha;
  }
  const mediaType = { png: 'image/png', jpeg: 'image/jpeg', avif: 'image/avif', pdf: 'application/pdf' }[settings.format];
  return { bytes: output, info: { format: settings.format, width: settings.width, height: settings.height, bytes: output.length, alpha, mediaType, warnings,
    ...(pageWidth ? { pageWidth, pageHeight } : {}) } };
}
