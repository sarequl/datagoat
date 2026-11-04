/** Byte/string encoding helpers that work in the Workers runtime and in browsers. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(input: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(input) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: ArrayBuffer | Uint8Array): string {
  return decoder.decode(bytes);
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("Invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(b64url: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(b64url)) throw new Error("Invalid base64url string");
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}
