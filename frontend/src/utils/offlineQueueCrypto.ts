/** Cifrado AES-GCM de la cola offline (clave en sessionStorage por usuario). */

const KEY_PREFIX = 'ts_ctpat_queue_aes_v1_';

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getOrCreateKey(userId: string): Promise<CryptoKey> {
  const storageKey = KEY_PREFIX + userId;
  let rawB64 = sessionStorage.getItem(storageKey);
  if (!rawB64) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    rawB64 = toB64(raw);
    sessionStorage.setItem(storageKey, rawB64);
  }
  const raw = fromB64(rawB64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptOfflinePayload(userId: string, plaintext: string): Promise<string> {
  const key = await getOrCreateKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `enc1.${toB64(iv)}.${toB64(cipher)}`;
}

export async function decryptOfflinePayload(userId: string, packed: string): Promise<string> {
  if (!packed.startsWith('enc1.')) return packed;
  const parts = packed.split('.');
  if (parts.length !== 3) throw new Error('Paquete cifrado inválido');
  const key = await getOrCreateKey(userId);
  const iv = fromB64(parts[1]!);
  const data = fromB64(parts[2]!);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plain);
}

export function clearOfflineCryptoKey(userId: string | null): void {
  if (!userId) return;
  try {
    sessionStorage.removeItem(KEY_PREFIX + userId);
  } catch {
    /* ignore */
  }
}
