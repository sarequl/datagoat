const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(digest);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(signature);
}

/**
 * Cookieless visitor id, per design/script.md §5.2:
 *   hex(HMAC_SHA256(install_secret, site_token + ip + user_agent + day_bucket))
 */
export async function deriveCookielessVid(
  installSecret: string,
  siteToken: string,
  ip: string,
  userAgent: string,
  dayBucket: string,
): Promise<string> {
  return hmacSha256Hex(installSecret, `${siteToken}${ip}${userAgent}${dayBucket}`);
}
