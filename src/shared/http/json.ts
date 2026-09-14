import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

/** Strict bounded JSON object decoding for feature request bodies. */
export const invalidBody = (): Failure =>
  failure('invalid', 'invalid request body', { type: 'http.invalid_body' });
const MAX_DEPTH = 8;
class Parser {
  #i = 0;
  constructor(private readonly text: string) {}
  #ws(): void {
    while (this.#i < this.text.length && ' \t\r\n'.includes(this.text[this.#i]))
      this.#i++;
  }
  #peek(): string { return this.text[this.#i] ?? ''; }
  #expect(ch: string): void {
    if (this.text[this.#i] !== ch) throw new SyntaxError('expected ' + ch);
    this.#i++;
  }
  parseDocument(): Record<string, unknown> {
    this.#ws();
    if (this.#peek() !== '{') throw new SyntaxError('object expected');
    const value = this.#object(1);
    this.#ws();
    if (this.#i !== this.text.length) throw new SyntaxError('trailing content');
    return value;
  }
  #value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new SyntaxError('too deep');
    this.#ws();
    const c = this.#peek();
    if (c === '{') return this.#object(depth);
    if (c === '[') return this.#array(depth);
    if (c === '"') return this.#string();
    if (c === 't') return this.#literal('true', true);
    if (c === 'f') return this.#literal('false', false);
    if (c === 'n') return this.#literal('null', null);
    return this.#number();
  }
  #literal<T>(word: string, value: T): T {
    if (this.text.startsWith(word, this.#i)) {
      this.#i += word.length;
      return value;
    }
    throw new SyntaxError('literal');
  }
  #number(): number {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.#i));
    if (!m) throw new SyntaxError('number');
    this.#i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) throw new SyntaxError('number');
    return n;
  }
  #string(): string {
    this.#expect('"');
    let out = '';
    for (;;) {
      if (this.#i >= this.text.length) throw new SyntaxError('unterminated');
      const c = this.text[this.#i++];
      if (c === '"') return out;
      if (c.charCodeAt(0) < 0x20) throw new SyntaxError('control character');
      if (c !== '\\') { out += c; continue; }
      const e = this.text[this.#i++];
      switch (e) {
        case '"': case '\\': case '/': out += e; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const unit = this.#unit();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (!this.text.startsWith('\\u', this.#i)) throw new SyntaxError('surrogate');
            this.#i += 2;
            const low = this.#unit();
            if (low < 0xdc00 || low > 0xdfff) throw new SyntaxError('surrogate');
            out += String.fromCharCode(unit, low);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new SyntaxError('surrogate');
          else out += String.fromCharCode(unit);
          break;
        }
        default: throw new SyntaxError('escape');
      }
    }
  }
  #unit(): number {
    const hex = this.text.slice(this.#i, this.#i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError('unicode escape');
    this.#i += 4;
    return parseInt(hex, 16);
  }
  #array(depth: number): unknown[] {
    this.#expect('[');
    const out: unknown[] = [];
    this.#ws();
    if (this.#peek() === ']') { this.#i++; return out; }
    for (;;) {
      out.push(this.#value(depth + 1));
      this.#ws();
      if (this.#peek() === ',') { this.#i++; continue; }
      this.#expect(']');
      return out;
    }
  }
  #object(depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) throw new SyntaxError('too deep');
    this.#expect('{');
    const out: Record<string, unknown> = Object.create(null);
    this.#ws();
    if (this.#peek() === '}') { this.#i++; return out; }
    for (;;) {
      this.#ws();
      const key = this.#string();
      if (Object.hasOwn(out, key)) throw new SyntaxError('duplicate key');
      this.#ws();
      this.#expect(':');
      out[key] = this.#value(depth + 1);
      this.#ws();
      if (this.#peek() === ',') { this.#i++; continue; }
      this.#expect('}');
      return out;
    }
  }
}
export function decodeObject(bytes: Uint8Array): Result<Record<string, unknown>, Failure> {
  try {
    return ok(new Parser(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).parseDocument());
  } catch {
    return err(invalidBody());
  }
}
export function stringFields<K extends string>(bytes: Uint8Array, names: readonly K[]): Result<Record<K, string>, Failure> {
  const decoded = decodeObject(bytes);
  if (!decoded.ok) return decoded;
  const keys = Object.keys(decoded.value);
  if (keys.length !== names.length) return err(invalidBody());
  const out = {} as Record<K, string>;
  for (const name of names) {
    const value = decoded.value[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return err(invalidBody());
    out[name] = value;
  }
  return ok(out);
}
