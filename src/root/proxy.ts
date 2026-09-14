import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { err, failure, type Failure, type Result } from '../shared/errors/index.js';

type Address = { readonly version: 4 | 6; readonly bytes: Uint8Array };
export type TrustedProxy = Readonly<{ network: Address; bits: number }>;

const invalid = (): Failure =>
  failure('invalid', 'invalid trusted proxy configuration', {
    type: 'env.invalid',
  });
function parseAddress(raw: string): Address | undefined {
  const version = isIP(raw);
  if (version === 4) {
    const values = raw.split('.').map(Number);
    if (values.length !== 4 || values.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
      return undefined;
    return { version: 4, bytes: Uint8Array.from(values) };
  }
  if (version !== 6) return undefined;
  let normalized = raw;
  if (raw.includes('.')) {
    const separator = raw.lastIndexOf(':');
    if (separator < 0) return undefined;
    const tail = parseAddress(raw.slice(separator + 1));
    if (!tail || tail.version !== 4) return undefined;
    const high = ((tail.bytes[0] << 8) | tail.bytes[1]).toString(16);
    const low = ((tail.bytes[2] << 8) | tail.bytes[3]).toString(16);
    normalized = raw.slice(0, separator + 1) + high + ':' + low;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...left, ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  const missing = 8 - groups.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
    return undefined;
  const all = [...left, ...Array(missing).fill('0'), ...right].map((v) => Number.parseInt(v, 16));
  const bytes = new Uint8Array(16);
  all.forEach((v, i) => {
    bytes[i * 2] = v >>> 8;
    bytes[i * 2 + 1] = v & 0xff;
  });
  if (
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  )
    return { version: 4, bytes: bytes.slice(12) };
  return { version: 6, bytes };
}
function canonical(address: Address): string {
  if (address.version === 4) return [...address.bytes].join('.');
  const groups = Array.from({ length: 8 }, (_, i) => (address.bytes[i * 2] * 256 + address.bytes[i * 2 + 1]).toString(16));
  let bestStart = -1, bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let end = i;
    while (end < 8 && groups[end] === '0') end++;
    if (end - i > bestLength) {
      bestStart = i;
      bestLength = end - i;
    }
    i = end;
  }
  if (bestLength < 2) return groups.join(':');
  return groups.slice(0, bestStart).join(':') + '::' + groups.slice(bestStart + bestLength).join(':');
}
function contains(proxy: TrustedProxy, address: Address): boolean {
  if (proxy.network.version !== address.version) return false;
  for (let bit = 0; bit < proxy.bits; bit++) {
    const mask = 0x80 >>> (bit % 8);
    if ((proxy.network.bytes[bit >>> 3] & mask) !== (address.bytes[bit >>> 3] & mask))
      return false;
  }
  return true;
}
function parseProxy(raw: string): TrustedProxy | undefined {
  const [addressText, bitsText] = raw.split('/');
  if (!addressText || raw.split('/').length > 2) return undefined;
  const address = parseAddress(addressText);
  const bits = bitsText === undefined ? (address?.version === 4 ? 32 : 128) : Number(bitsText);
  if (!address || !Number.isInteger(bits) || bits < 0 || bits > (address.version === 4 ? 32 : 128))
    return undefined;
  const network = new Uint8Array(address.bytes);
  for (let bit = bits; bit < network.length * 8; bit++)
    network[bit >>> 3] &= ~(0x80 >>> (bit % 8));
  return { network: { ...address, bytes: network }, bits };
}
export function parseTrustedProxies(raw: string): Result<readonly TrustedProxy[], Failure> {
  const proxies = raw.split(',').map((value) => value.trim()).filter(Boolean).map(parseProxy);
  return proxies.every((value): value is TrustedProxy => value !== undefined)
    ? { ok: true, value: proxies }
    : err(invalid());
}
export function trustedSource(
  proxies: readonly TrustedProxy[],
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders,
): string {
  const peer = remoteAddress ? parseAddress(remoteAddress) : undefined;
  if (!peer) return remoteAddress ?? '';
  const peerValue = canonical(peer);
  if (!proxies.length || !proxies.some((proxy) => contains(proxy, peer))) return peerValue;
  const raw = headers['x-forwarded-for'];
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const chain: Address[] = [];
  for (const value of values) {
    if (typeof value !== 'string') return peerValue;
    for (const part of value.split(',')) {
      const address = parseAddress(part.trim());
      if (!address) return peerValue;
      chain.push(address);
    }
  }
  if (!chain.length) return peerValue;
  chain.push(peer);
  for (let i = chain.length - 1; i >= 0; i--)
    if (!proxies.some((proxy) => contains(proxy, chain[i]))) return canonical(chain[i]);
  return canonical(chain[0]);
}
