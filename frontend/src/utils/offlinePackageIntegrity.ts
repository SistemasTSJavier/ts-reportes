/** Versión del esquema de hash para paquetes offline (cola syncStore). */
export const OFFLINE_INTEGRITY_VERSION = 1;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Serialización estable (claves ordenadas) para hash reproducible. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 del payload de registro antes de sincronizar (incluye data URLs de evidencias). */
export async function computeOfflinePackageIntegrityHash(
  insertPayloadBase: Record<string, unknown>
): Promise<string> {
  return sha256Hex(stableStringify(insertPayloadBase));
}

export async function verifyOfflinePackageIntegrity(
  insertPayloadBase: Record<string, unknown>,
  expectedHash: string
): Promise<boolean> {
  if (!expectedHash) return false;
  const actual = await computeOfflinePackageIntegrityHash(insertPayloadBase);
  return actual === expectedHash;
}
