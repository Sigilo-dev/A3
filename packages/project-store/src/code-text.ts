export type CodeEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom';
export type CodeLineEnding = 'lf' | 'crlf' | 'none' | 'mixed' | 'cr';
export interface DecodedCodeText {
  content: string | null; encoding: CodeEncoding | null; lineEnding: CodeLineEnding;
  state: 'text' | 'binary' | 'unsupported-encoding'; readOnlyReason: string | null;
}
export type CodeOpenTarget = { itemId: string } | { resourceId: string; entityId?: string };
export interface CodeDocument extends DecodedCodeText {
  documentId: string; resourceId: string | null; revision: number | null; hash: string;
  name: string; relativePath: string; size: number; canWrite: boolean; languageHint: string | null;
}

export function codeLineEnding(value: string): CodeLineEnding {
  const crlf = /\r\n/.test(value), lf = /(?<!\r)\n/.test(value), cr = /\r(?!\n)/.test(value);
  return Number(crlf) + Number(lf) + Number(cr) > 1 ? 'mixed' : cr ? 'cr' : crlf ? 'crlf' : lf ? 'lf' : 'none';
}

export function encodeCodeText(content: string, encoding: CodeEncoding): Uint8Array {
  if (Buffer.from(content, 'utf8').toString('utf8') !== content) throw new Error('El buffer contiene un sustituto Unicode incompleto.');
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') {
    return Buffer.concat([encoding === 'utf-8-bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(content, 'utf8')]);
  }
  const payload = Buffer.from(content, 'utf16le');
  if (encoding === 'utf-16be-bom') payload.swap16();
  return Buffer.concat([Buffer.from(encoding === 'utf-16le-bom' ? [0xff, 0xfe] : [0xfe, 0xff]), payload]);
}

/** No legacy encoding guessing. The decoded source must reproduce every input byte. */
export function decodeCodeText(input: Uint8Array): DecodedCodeText {
  const bytes = Buffer.from(input);
  // Some binary containers have ASCII headers and could otherwise pass UTF-8 validation.
  const header = bytes.subarray(0, 12).toString('latin1');
  if (/^(%PDF-|GIF8[79]a|PK\x03\x04|\x89PNG|\x7fELF|MZ|RIFF|OggS|fLaC|\xff\xd8\xff)/.test(header)) {
    return { content: null, encoding: null, lineEnding: 'none', state: 'binary', readOnlyReason: 'Formato binario reconocido; no se abre como texto.' };
  }
  let encoding: CodeEncoding = 'utf-8', offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = 'utf-8-bom'; offset = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le-bom'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be-bom'; offset = 2; }
  try {
    const name = encoding.startsWith('utf-16') ? encoding === 'utf-16le-bom' ? 'utf-16le' : 'utf-16be' : 'utf-8';
    const content = new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(content)) return { content: null, encoding: null, lineEnding: 'none', state: 'binary', readOnlyReason: 'El archivo contiene bytes de control binarios; no se abre como texto.' };
    if (!Buffer.from(encodeCodeText(content, encoding)).equals(bytes)) throw new Error('round-trip');
    const lineEnding = codeLineEnding(content);
    return { content, encoding, lineEnding, state: 'text', readOnlyReason: lineEnding === 'mixed' || lineEnding === 'cr'
      ? 'Finales de línea mezclados o CR aislado: solo lectura para conservar la representación original.' : null };
  } catch {
    return { content: null, encoding: null, lineEnding: 'none', state: 'unsupported-encoding', readOnlyReason: 'No se garantiza la codificación de este archivo. Se conservan los bytes y se desactiva la edición.' };
  }
}
