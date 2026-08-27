// Elimina filas vencidas y sus objetos en Storage (PDF + evidencias).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PDF_BUCKET = 'ctpat-pdfs';
const EVIDENCE_BUCKET = Deno.env.get('EVIDENCE_BUCKET') ?? 'ctpat-evidence';

function isAuthorized(req: Request): boolean {
  const purgeSecret = Deno.env.get('PURGE_CRON_SECRET')?.trim();
  if (purgeSecret) {
    const header = req.headers.get('X-Purge-Secret')?.trim();
    return header === purgeSecret;
  }
  const auth = req.headers.get('Authorization')?.trim() ?? '';
  return auth === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(null) });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(null) }
    });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(null) }
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const { data: expired, error: listErr } = await supabase
    .from('registros_ctpat')
    .select('id, user_id, pdf_storage_path, image_urls, firma_operador, firma_oficial')
    .not('expires_at', 'is', null)
    .lte('expires_at', new Date().toISOString())
    .limit(200);

  if (listErr) {
    console.error('[purge-expired-ctpat-data] list', listErr.message);
    return new Response(JSON.stringify({ ok: false, error: listErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(null) }
    });
  }

  let storageRemoved = 0;
  for (const row of expired ?? []) {
    const pathsPdf: string[] = [];
    if (row.pdf_storage_path) pathsPdf.push(String(row.pdf_storage_path));
    if (pathsPdf.length) {
      const { error } = await supabase.storage.from(PDF_BUCKET).remove(pathsPdf);
      if (!error) storageRemoved += pathsPdf.length;
    }

    const evidencePaths: string[] = [];
    if (Array.isArray(row.image_urls)) {
      for (const p of row.image_urls) {
        if (typeof p === 'string' && p && !p.startsWith('http') && !p.startsWith('data:')) {
          evidencePaths.push(p);
        }
      }
    }
    for (const sig of [row.firma_operador, row.firma_oficial]) {
      if (typeof sig === 'string' && sig && !sig.startsWith('http') && !sig.startsWith('data:')) {
        evidencePaths.push(sig);
      }
    }
    if (evidencePaths.length) {
      const { error } = await supabase.storage.from(EVIDENCE_BUCKET).remove(evidencePaths);
      if (!error) storageRemoved += evidencePaths.length;
    }
  }

  const { data, error } = await supabase.rpc('purge_expired_ctpat_registros');
  if (error) {
    console.error('[purge-expired-ctpat-data]', error.message);
    return new Response(JSON.stringify({ ok: false, error: error.message, storageRemoved }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(null) }
    });
  }

  const deleted = typeof data === 'number' ? data : Number(data ?? 0);
  console.log('[purge-expired-ctpat-data] filas:', deleted, 'storage:', storageRemoved);

  return new Response(JSON.stringify({ ok: true, deleted, storageRemoved }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(null) }
  });
});
