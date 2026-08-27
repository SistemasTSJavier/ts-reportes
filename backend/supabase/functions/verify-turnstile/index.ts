// Verifica Cloudflare Turnstile y emite / consume tickets de login (HMAC).
// No requiere JWT de usuario.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function json(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP')?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerify(secret: string, message: string, hex: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  if (expected.length !== hex.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) ok |= expected.charCodeAt(i) ^ hex.charCodeAt(i);
  return ok === 0;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return json(origin, 405, { ok: false, error: 'Method not allowed' });
  }

  const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY')?.trim();
  const ticketSecret = Deno.env.get('TURNSTILE_TICKET_SECRET')?.trim() || turnstileSecret;
  if (!turnstileSecret || !ticketSecret) {
    return json(origin, 503, {
      ok: false,
      error: 'Turnstile no configurado (TURNSTILE_SECRET_KEY / TURNSTILE_TICKET_SECRET).'
    });
  }

  let body: { token?: unknown; action?: unknown; loginTicket?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(origin, 400, { ok: false, error: 'JSON inválido.' });
  }

  const action = typeof body.action === 'string' ? body.action.trim() : 'verify';
  const ip = clientIp(req);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  // Rate limit: 20 hits / 15 min por IP
  const windowStart = new Date();
  windowStart.setUTCMinutes(Math.floor(windowStart.getUTCMinutes() / 15) * 15, 0, 0);
  const { data: rateRow } = await supabase
    .from('turnstile_rate_by_ip')
    .select('hit_count')
    .eq('client_ip', ip)
    .eq('window_start', windowStart.toISOString())
    .maybeSingle();
  const hits = (rateRow?.hit_count as number | undefined) ?? 0;
  if (hits >= 20) {
    return json(origin, 429, { ok: false, error: 'Demasiadas solicitudes. Espera unos minutos.' });
  }
  await supabase.from('turnstile_rate_by_ip').upsert(
    {
      client_ip: ip,
      window_start: windowStart.toISOString(),
      hit_count: hits + 1
    },
    { onConflict: 'client_ip,window_start' }
  );

  if (action === 'consume') {
    const ticket = typeof body.loginTicket === 'string' ? body.loginTicket.trim() : '';
    const parts = ticket.split('.');
    if (parts.length !== 3) {
      return json(origin, 400, { ok: false, error: 'Ticket inválido.' });
    }
    const [jti, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!jti || !Number.isFinite(exp) || exp * 1000 < Date.now()) {
      return json(origin, 403, { ok: false, error: 'Ticket expirado o inválido.' });
    }
    const msg = `${jti}.${expStr}`;
    if (!(await hmacVerify(ticketSecret, msg, sig))) {
      return json(origin, 403, { ok: false, error: 'Ticket inválido.' });
    }
    const { data: row } = await supabase
      .from('login_tickets')
      .select('jti, used_at, expires_at')
      .eq('jti', jti)
      .maybeSingle();
    if (!row || row.used_at || new Date(row.expires_at as string).getTime() < Date.now()) {
      return json(origin, 403, { ok: false, error: 'Ticket ya usado o inválido.' });
    }
    const { error: upErr } = await supabase
      .from('login_tickets')
      .update({ used_at: new Date().toISOString() })
      .eq('jti', jti)
      .is('used_at', null);
    if (upErr) {
      return json(origin, 500, { ok: false, error: 'No se pudo consumir el ticket.' });
    }
    return json(origin, 200, { ok: true, consumed: true });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return json(origin, 400, { ok: false, error: 'token requerido.' });
  }

  const params = new URLSearchParams({ secret: turnstileSecret, response: token });
  if (ip && ip !== 'unknown') params.set('remoteip', ip);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success !== true) {
      return json(origin, 403, {
        ok: false,
        error: 'Verificación de Cloudflare rechazada.',
        codes: data['error-codes'] ?? []
      });
    }

    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const msg = `${jti}.${exp}`;
    const sig = await hmacSign(ticketSecret, msg);
    const loginTicket = `${msg}.${sig}`;

    const { error: insErr } = await supabase.from('login_tickets').insert({
      jti,
      expires_at: new Date(exp * 1000).toISOString(),
      client_ip: ip
    });
    if (insErr) {
      console.warn('[verify-turnstile] login_tickets insert:', insErr.message);
      return json(origin, 500, { ok: false, error: 'No se pudo emitir ticket de login.' });
    }

    return json(origin, 200, { ok: true, loginTicket, expiresAt: exp });
  } catch (e) {
    return json(origin, 502, {
      ok: false,
      error: e instanceof Error ? e.message : 'No se pudo contactar a Cloudflare.'
    });
  }
});
