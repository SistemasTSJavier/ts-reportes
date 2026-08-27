/** CORS allowlist for Edge Functions (browser callers). */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const o = origin.trim().replace(/\/$/, '');
  if (o === 'https://tacticalsupport.online') return true;
  if (o === 'http://localhost:5173' || o === 'http://127.0.0.1:5173') return true;
  if (o === 'http://localhost:4173' || o === 'http://127.0.0.1:4173') return true;
  if (/^http:\/\/localhost:\d+$/.test(o) || /^http:\/\/127\.0\.0\.1:\d+$/.test(o)) return true;
  return false;
}

export function corsHeaders(origin: string | null): HeadersInit {
  const allowed = isAllowedOrigin(origin);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-webhook-secret, x-purge-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin'
  };
  if (allowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}
