import type { JsonValue } from '@a3/domain';

export const object = (v: unknown): v is Record<string, JsonValue> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const pointerToken = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
/** Iterative budget check before recursive schema/canonical code; never evaluates accessors. */
export function exceedsDepth(value: unknown, limit: number): boolean {
  const pending = [{ value, depth: 0 }];
  const seen = new Map<object, number>();
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > limit) return true;
    if (next.value === null || typeof next.value !== 'object') continue;
    if ((seen.get(next.value) ?? -1) >= next.depth) continue;
    seen.set(next.value, next.depth);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(next.value))) {
      if (Array.isArray(next.value) && key === 'length' || descriptor.get || descriptor.set) continue;
      pending.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
  return false;
}
export function hasNegativeZero(value: unknown): boolean {
  return typeof value === 'number' ? Object.is(value, -0) : value !== null && typeof value === 'object' && Object.values(value).some(hasNegativeZero);
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export class JsonSyntaxError extends Error {
  constructor(message: string, readonly offset: number, readonly detail = 'invalid-json') { super(message); }
}
export interface JsonConcern { detail: string; message: string; offset: number; pointer: string; }
export interface ParsedJson { value: JsonValue; positions: Map<string, number>; concerns: JsonConcern[]; }

// Compare exact decimal values before admitting a token to the Number model.
// Formatting differences such as 1.00 / 1e0 are safe; rounding, -0 and overflow are not.
function decimal(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  let digits = (match[2]! + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return match[1] === '-' ? '-0' : '0';
  const zeros = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - zeros);
  const exponent = (match[4] ?? '0').replace(/^([+-]?)0+/, '$1') || '0';
  if (exponent.replace(/^[+-]/, '').length > 10) return 'unrepresentable-exponent';
  return `${match[1]}${digits}e${BigInt(exponent === '+' || exponent === '-' ? '0' : exponent) - BigInt((match[3] ?? '').length) + BigInt(zeros)}`;
}

/** Strict grammar with source positions. Duplicate keys and lossy numbers are quarantined. */
export function parseJson(text: string): ParsedJson {
  let p = text.startsWith('\uFEFF') ? 1 : 0;
  const positions = new Map<string, number>();
  const concerns: JsonConcern[] = [];
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const fail = (message: string): never => { throw new JsonSyntaxError(message, p); };
  const whitespace = (): void => { while (/[ \t\r\n]/.test(text[p] ?? '\0')) p++; };
  function string(): string {
    const start = p++;
    while (p < text.length) {
      const char = text[p++]!;
      if (char === '"') return JSON.parse(text.slice(start, p)) as string;
      if (char.charCodeAt(0) < 32) { p--; fail('Carácter de control en una cadena JSON.'); }
      if (char === '\\') {
        const escape = text[p++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(p, p + 4))) fail('Escape Unicode incompleto o inválido.');
          p += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) fail('Escape JSON inválido.');
      }
    }
    return fail('Cadena JSON sin cierre.');
  }
  function value(pointer: string, depth: number): JsonValue {
    whitespace();
    positions.set(pointer, p);
    if (depth > 128) throw new JsonSyntaxError('Se excedió el límite de profundidad JSON (128); solo inspección de bytes.', p, 'json-depth-limit');
    const start = p;
    const char = text[p];
    if (char === '"') return string();
    if (char === '{') {
      p++; whitespace();
      const result: Record<string, JsonValue> = {};
      if (text[p] === '}') { p++; return result; }
      while (true) {
        if (text[p] !== '"') fail('Se esperaba una clave JSON entre comillas.');
        const keyStart = p;
        const key = string();
        const child = pointer + '/' + pointerToken(key);
        if (Object.hasOwn(result, key) && concerns.length < 100) concerns.push({ detail: 'duplicate-json-key', message: 'Clave JSON repetida; inspección de bytes sin elegir un valor.', offset: keyStart, pointer: child });
        whitespace();
        if (text[p++] !== ':') { p--; fail('Se esperaba : después de la clave.'); }
        const parsed = value(child, depth + 1);
        Object.defineProperty(result, key, { value: parsed, enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[p] === '}') { p++; return result; }
        if (text[p++] !== ',') { p--; fail('Se esperaba , o } en el objeto.'); }
        whitespace();
      }
    }
    if (char === '[') {
      p++; whitespace();
      const result: JsonValue[] = [];
      if (text[p] === ']') { p++; return result; }
      while (true) {
        result.push(value(pointer + '/' + result.length, depth + 1));
        whitespace();
        if (text[p] === ']') { p++; return result; }
        if (text[p++] !== ',') { p--; fail('Se esperaba , o ] en el array.'); }
      }
    }
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, p)) { p += word.length; return literal; }
    }
    numberPattern.lastIndex = p;
    const match = numberPattern.exec(text);
    if (!match) return fail('Se esperaba un valor JSON.');
    p += match[0].length;
    const number = Number(match[0]);
    if ((!Number.isFinite(number) || decimal(match[0]) !== decimal(String(number))) && concerns.length < 100) {
      concerns.push({ detail: 'number-not-lossless', message: 'Número no representable sin pérdida; se conserva el documento en bytes, sin reescritura.', offset: start, pointer });
    }
    return number;
  }
  const parsed = value('', 0);
  whitespace();
  if (p !== text.length) fail('Contenido adicional después del valor JSON.');
  return { value: parsed, positions, concerns };
}

/** Sort keys by UTF-16 code units, including numeric-looking keys; keep array order. */
export function canonicalJson(value: JsonValue, depth = 0): string {
  const indent = '  '.repeat(depth);
  const childIndent = indent + '  ';
  if (Array.isArray(value)) return value.length ? '[\n' + value.map((v) => childIndent + canonicalJson(v, depth + 1)).join(',\n') + '\n' + indent + ']' : '[]';
  if (object(value)) {
    const keys = Object.keys(value).sort();
    return keys.length ? '{\n' + keys.map((k) => childIndent + JSON.stringify(k) + ': ' + canonicalJson(value[k]!, depth + 1)).join(',\n') + '\n' + indent + '}' : '{}';
  }
  return JSON.stringify(value);
}

export function sourcePosition(text: string, offset: number): { line: number; column: number; byteOffset: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines.at(-1)!.length + 1, byteOffset: Buffer.byteLength(prefix, 'utf8') };
}

/** First invalid UTF-8 byte; accepts a UTF-8 BOM as source formatting. */
export function invalidUtf8(bytes: Uint8Array): number | undefined {
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i]!;
    if (first < 0x80) { i++; continue; }
    const length = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    if (!length || i + length > bytes.length) return i;
    for (let j = 1; j < length; j++) {
      const next = bytes[i + j]!;
      if (next < 0x80 || next > 0xbf || j === 1 && (
        first === 0xe0 && next < 0xa0 || first === 0xed && next > 0x9f ||
        first === 0xf0 && next < 0x90 || first === 0xf4 && next > 0x8f)) return i + j;
    }
    i += length;
  }
  return undefined;
}
