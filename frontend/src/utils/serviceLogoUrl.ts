import { supabase } from '../supabaseClient';

/** Mismo bucket que la Edge Function del PDF (`LOGO_BUCKET`, por defecto `ctpat-logs`). */
const BUCKET = (import.meta.env.VITE_LOGO_BUCKET as string | undefined)?.trim();

const signedUrlCache = new Map<string, { url: string; until: number }>();

/**
 * URL para mostrar el logo de servicio en la PWA.
 * Logos en Storage usan signed URL (bucket privado).
 */
export function getServiceLogoPublicUrl(filename: string | null | undefined): string {
  const name = filename?.trim() ?? '';
  if (!name) return '';
  if (!/^[a-zA-Z0-9/_\.-]+\.(png|jpe?g)$/i.test(name)) return '';
  const useBucket = Boolean(BUCKET && name.toLowerCase().startsWith('logos/'));
  if (useBucket) {
    const cached = signedUrlCache.get(name);
    if (cached && cached.until > Date.now()) return cached.url;
    // Sync fallback vacío; callers that need display should use resolveServiceLogoUrl.
    void resolveServiceLogoUrl(name);
    return cached?.url ?? '';
  }
  return name.startsWith('/') ? name : `/${name}`;
}

/** Resuelve signed URL para logos en bucket privado. */
export async function resolveServiceLogoUrl(
  filename: string | null | undefined
): Promise<string> {
  const name = filename?.trim() ?? '';
  if (!name) return '';
  if (!BUCKET || !name.toLowerCase().startsWith('logos/')) {
    return name.startsWith('/') ? name : `/${name}`;
  }
  const cached = signedUrlCache.get(name);
  if (cached && cached.until > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(name, 3600);
  if (error || !data?.signedUrl) return '';
  signedUrlCache.set(name, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}
