/** AES-GCM helpers for Google refresh tokens (Edge). */
export async function importAesKey(rawSecret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  let keyBytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(rawSecret)) {
    keyBytes = new Uint8Array(rawSecret.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  } else {
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(rawSecret));
    keyBytes = new Uint8Array(hash);
  }
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(rawSecret: string, plaintext: string): Promise<string> {
  const key = await importAesKey(rawSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function decryptSecret(rawSecret: string, packedB64: string): Promise<string> {
  const key = await importAesKey(rawSecret);
  const packed = Uint8Array.from(atob(packedB64), (c) => c.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const data = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plain);
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID')?.trim() ?? '';
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET')?.trim() ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error ?? `Google token refresh HTTP ${res.status}`);
  }
  return json.access_token;
}
