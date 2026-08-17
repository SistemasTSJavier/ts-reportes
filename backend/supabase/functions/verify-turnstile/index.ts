// Verifica el token de Cloudflare Turnstile antes de permitir el login.
// No requiere JWT: el usuario aún no está autenticado.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function json(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return json(origin, 405, { ok: false, error: 'Method not allowed' });
  }

  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')?.trim();
  if (!secret) {
    return json(origin, 503, {
      ok: false,
      error: 'Turnstile no configurado (falta TURNSTILE_SECRET_KEY).'
    });
  }

  let token = '';
  try {
    const body = (await req.json()) as { token?: unknown };
    token = typeof body.token === 'string' ? body.token.trim() : '';
  } catch {
    return json(origin, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!token) {
    return json(origin, 400, { ok: false, error: 'token requerido.' });
  }

  const remoteip =
    req.headers.get('CF-Connecting-IP')?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '';

  const params = new URLSearchParams({ secret, response: token });
  if (remoteip) params.set('remoteip', remoteip);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success === true) {
      return json(origin, 200, { ok: true });
    }
    return json(origin, 403, {
      ok: false,
      error: 'Verificación de Cloudflare rechazada.',
      codes: data['error-codes'] ?? []
    });
  } catch (e) {
    return json(origin, 502, {
      ok: false,
      error: e instanceof Error ? e.message : 'No se pudo contactar a Cloudflare.'
    });
  }
});
