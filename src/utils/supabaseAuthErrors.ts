/**
 * Detecta errores de Supabase/PostgREST/GoTrue que requieren volver a iniciar sesión.
 * Evita mostrar al usuario textos crudos como "401" o "Invalid JWT".
 */
export function isSessionExpiredError(
  message: string | null | undefined,
  code?: string | null | undefined
): boolean {
  const c = (code ?? '').toString();
  if (c === '401' || c === 'PGRST301' || c === 'PGRST302') return true;

  const m = (message ?? '').toLowerCase();
  if (!m.trim()) return false;

  if (m.includes('http 401') || m.includes('status code 401')) return true;
  if (m.includes('invalid jwt') || m.includes('invalid token')) return true;
  if (m.includes('jwt expired') || m.includes('token expired')) return true;
  if (m.includes('authorization') && m.includes('failed')) return true;
  if (m.includes('session') && (m.includes('missing') || m.includes('invalid'))) return true;
  if (m.includes('refresh_token') && (m.includes('invalid') || m.includes('revoked'))) return true;

  return false;
}

/** Texto para toasts (sin códigos HTTP). */
export const SESSION_EXPIRED = {
  title: 'Sesión finalizada',
  message:
    'Por seguridad hay que volver a entrar. Usa «Iniciar con Google» en la parte superior.'
} as const;

/** Mensaje breve para cola de sincronización / historial de errores. */
export const SESSION_EXPIRED_SHORT = 'Sesión finalizada. Inicia sesión de nuevo con Google.';
