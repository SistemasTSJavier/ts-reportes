// Admin: borra Storage (service_role) + datos públicos + Auth user.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

function json(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

async function removePaths(
  admin: ReturnType<typeof createClient>,
  bucket: string,
  paths: string[]
): Promise<number> {
  let n = 0;
  for (let i = 0; i < paths.length; i += 50) {
    const chunk = paths.slice(i, i + 50);
    const { error } = await admin.storage.from(bucket).remove(chunk);
    if (!error) n += chunk.length;
    else console.warn('[admin-delete-user] remove', bucket, error.message);
  }
  return n;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return json(origin, 405, { ok: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.get('Authorization')?.trim() ?? '';
  if (!authHeader) {
    return json(origin, 401, { ok: false, error: 'Unauthorized' });
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return json(origin, 401, { ok: false, error: 'Sesión inválida.' });
  }

  const aal = (userData.user as { aal?: string }).aal
    ?? (userData.user.app_metadata as { aal?: string } | undefined)?.aal;
  // JWT claim aal is on the session token; re-check via RPC
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const { data: adminRow } = await admin
    .from('app_admins')
    .select('user_id')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (!adminRow) {
    return json(origin, 403, { ok: false, error: 'No autorizado.' });
  }

  // Prefer JWT aal from Authorization payload
  let jwtAal = 'aal1';
  try {
    const raw = authHeader.replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(raw.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    jwtAal = typeof payload.aal === 'string' ? payload.aal : 'aal1';
  } catch {
    jwtAal = 'aal1';
  }
  if (jwtAal !== 'aal2') {
    return json(origin, 403, {
      ok: false,
      error: 'Se requiere MFA (AAL2) para eliminar usuarios.',
      aal: jwtAal
    });
  }

  let targetUserId = '';
  try {
    const body = (await req.json()) as { userId?: string };
    targetUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
  } catch {
    return json(origin, 400, { ok: false, error: 'JSON inválido.' });
  }
  if (!targetUserId) {
    return json(origin, 400, { ok: false, error: 'userId requerido.' });
  }
  if (targetUserId === userData.user.id) {
    return json(origin, 400, { ok: false, error: 'No puedes eliminar tu propia cuenta.' });
  }

  const { data: prep, error: prepErr } = await admin.rpc('admin_prepare_user_delete', {
    p_user_id: targetUserId
  });
  if (prepErr) {
    return json(origin, 500, { ok: false, error: prepErr.message });
  }
  const prepRow = prep as { ok?: boolean; error?: string; files?: { bucket?: string; name?: string }[] } | null;
  if (!prepRow?.ok) {
    return json(origin, 403, { ok: false, error: prepRow?.error ?? 'No se pudo preparar el borrado.' });
  }

  const byBucket = new Map<string, string[]>();
  for (const f of prepRow.files ?? []) {
    const b = f.bucket?.trim();
    const n = f.name?.trim();
    if (!b || !n) continue;
    const list = byBucket.get(b) ?? [];
    if (!list.includes(n)) list.push(n);
    byBucket.set(b, list);
  }

  // Also list prefixes for evidence/pdfs
  for (const bucket of ['ctpat-pdfs', 'ctpat-evidence'] as const) {
    const { data: listed } = await admin.storage.from(bucket).list(targetUserId, { limit: 100 });
    if (listed?.length) {
      const paths = listed.map((x) => `${targetUserId}/${x.name}`);
      const cur = byBucket.get(bucket) ?? [];
      for (const p of paths) if (!cur.includes(p)) cur.push(p);
      byBucket.set(bucket, cur);
    }
  }

  let removed = 0;
  for (const [bucket, names] of byBucket) {
    removed += await removePaths(admin, bucket, names);
  }

  const { error: delAuthErr } = await admin.auth.admin.deleteUser(targetUserId);
  if (delAuthErr) {
    return json(origin, 200, {
      ok: true,
      storageRemoved: removed,
      authDeleted: false,
      warning: delAuthErr.message,
      message: 'Datos y Storage limpiados. Borra el usuario en Authentication manualmente.'
    });
  }

  return json(origin, 200, {
    ok: true,
    storageRemoved: removed,
    authDeleted: true,
    message: 'Usuario y datos eliminados por completo.'
  });
});
