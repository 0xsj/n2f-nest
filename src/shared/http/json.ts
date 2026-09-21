import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

/** Strict bounded JSON object decoding for request bodies. */
export const invalidBody = (): Failure =>
  failure('invalid', 'invalid request body', { type: 'http.invalid_body' });

const MAX_DEPTH = 8;

class Parser {
  #i = 0;

  constructor(private readonly text: string) {}

  #ws(): void {
    while (
      this.#i < this.text.length &&
      ' \t\r\n'.includes(this.text[this.#i])
    ) {
      this.#i += 1;
    }
  }

  #peek(): string {
    return this.text[this.#i] ?? '';
  }

  #expect(character: string): void {
    if (this.text[this.#i] !== character) {
      throw new SyntaxError('expected ' + character);
    }
    this.#i += 1;
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
    const character = this.#peek();
    if (character === '{') return this.#object(depth);
    if (character === '[') return this.#array(depth);
    if (character === '"') return this.#string();
    if (character === 't') return this.#literal('true', true);
    if (character === 'f') return this.#literal('false', false);
    if (character === 'n') return this.#literal('null', null);
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
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(
      this.text.slice(this.#i),
    );
    if (!match) throw new SyntaxError('number');
    this.#i += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new SyntaxError('number');
    return number;
  }

  #string(): string {
    this.#expect('"');
    let output = '';
    for (;;) {
      if (this.#i >= this.text.length) throw new SyntaxError('unterminated');
      const character = this.text[this.#i++];
      if (character === '"') return output;
      if (character.charCodeAt(0) < 0x20) {
        throw new SyntaxError('control character');
      }
      if (character !== '\\') {
        output += character;
        continue;
      }
      const escaped = this.text[this.#i++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          output += escaped;
          break;
        case 'b':
          output += '\b';
          break;
        case 'f':
          output += '\f';
          break;
        case 'n':
          output += '\n';
          break;
        case 'r':
          output += '\r';
          break;
        case 't':
          output += '\t';
          break;
        case 'u': {
          const unit = this.#unit();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (!this.text.startsWith('\\u', this.#i)) {
              throw new SyntaxError('surrogate');
            }
            this.#i += 2;
            const low = this.#unit();
            if (low < 0xdc00 || low > 0xdfff) {
              throw new SyntaxError('surrogate');
            }
            output += String.fromCharCode(unit, low);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new SyntaxError('surrogate');
          } else {
            output += String.fromCharCode(unit);
          }
          break;
        }
        default:
          throw new SyntaxError('escape');
      }
    }
  }

  #unit(): number {
    const hex = this.text.slice(this.#i, this.#i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new SyntaxError('unicode escape');
    }
    this.#i += 4;
    return parseInt(hex, 16);
  }

  #array(depth: number): unknown[] {
    this.#expect('[');
    const output: unknown[] = [];
    this.#ws();
    if (this.#peek() === ']') {
      this.#i += 1;
      return output;
    }
    for (;;) {
      output.push(this.#value(depth + 1));
      this.#ws();
      if (this.#peek() === ',') {
        this.#i += 1;
        continue;
      }
      this.#expect(']');
      return output;
    }
  }

  #object(depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) throw new SyntaxError('too deep');
    this.#expect('{');
    const output: Record<string, unknown> = Object.create(null);
    this.#ws();
    if (this.#peek() === '}') {
      this.#i += 1;
      return output;
    }
    for (;;) {
      this.#ws();
      const key = this.#string();
      if (Object.hasOwn(output, key)) throw new SyntaxError('duplicate key');
      this.#ws();
      this.#expect(':');
      output[key] = this.#value(depth + 1);
      this.#ws();
      if (this.#peek() === ',') {
        this.#i += 1;
        continue;
      }
      this.#expect('}');
      return output;
    }
  }
}

export function decodeObject(
  bytes: Uint8Array,
): Result<Record<string, unknown>, Failure> {
  try {
    if (bytes.byteLength > 1048576) return err(invalidBody());
    return ok(
      new Parser(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ).parseDocument(),
    );
  } catch {
    return err(invalidBody());
  }
}

export function stringFields<K extends string>(
  bytes: Uint8Array,
  names: readonly K[],
): Result<Record<K, string>, Failure> {
  const decoded = decodeObject(bytes);
  if (!decoded.ok) return decoded;
  const keys = Object.keys(decoded.value);
  if (keys.length !== names.length) return err(invalidBody());
  const output = {} as Record<K, string>;
  for (const name of names) {
    const value = decoded.value[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      return err(invalidBody());
    }
    output[name] = value;
  }
  return ok(output);
}
