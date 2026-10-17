export type ImageOutputFormat = 'png' | 'jpeg' | 'avif' | 'pdf';
export interface ImageConversionSettings {
  format: ImageOutputFormat; width: number; height: number; quality: number;
  transparency: 'preserve' | 'flatten'; background: string;
  paper: 'A3' | 'A4'; orientation: 'portrait' | 'landscape'; marginMm: number;
}
export interface ImageInspection {
  format: string; width: number; height: number; bytes: number; alpha: boolean; pages: number;
  depth: string; orientation?: number; hasMetadata: boolean; supported: boolean; warnings: string[];
}
export interface ImageEngineInfo {
  sharp: string; vips: string; pdfLib: string; platform: string;
  profiles: { format: ImageOutputFormat; available: boolean; reason?: string }[];
}
export interface ImageOutputInfo {
  format: ImageOutputFormat; width: number; height: number; bytes: number; alpha: boolean;
  mediaType: string; warnings: string[]; pageWidth?: number; pageHeight?: number;
}
export interface ImageConversionView {
  jobId: string; state: 'inspected' | 'converting' | 'staged' | 'saving' | 'saved' | 'cancelled' | 'conflict' | 'error';
  resourceId: string; sourceName: string; source: ImageInspection; engine: ImageEngineInfo;
  output?: ImageOutputInfo & { path: string }; message?: string; outputResourceId?: string;
}
export type ImageConversionRequest =
  | { action: 'inspect'; sessionId: string; resourceId: string; jobId: string }
  | { action: 'convert'; sessionId: string; jobId: string; settings: ImageConversionSettings; destination: string }
  | { action: 'save' | 'cancel'; sessionId: string; jobId: string };
export type ImageConversionResult = { ok: true; value: ImageConversionView } |
  { ok: false; error: { code: string; message: string; recovery: string } };
