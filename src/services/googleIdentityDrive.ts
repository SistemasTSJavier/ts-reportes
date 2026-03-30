/**
 * Google Identity Services (GIS) — token OAuth2 para la API de Drive en el navegador.
 * Más robusto que depender solo de `provider_token` en la sesión de Supabase.
 *
 * Requiere en Vercel / .env: VITE_GOOGLE_OAUTH_CLIENT_ID = Client ID (Web) de Google Cloud
 * (el mismo tipo que usas en Supabase → Authentication → Google).
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: GisTokenResponse) => void;
          }) => GisTokenClient;
        };
      };
    };
  }
}

interface GisTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive'
].join(' ');

/** Mensaje cuando el navegador bloquea el popup de OAuth (GIS). */
export const DRIVE_POPUP_BLOCKED_MESSAGE =
  'El navegador bloqueó la ventana de Google. Permite ventanas emergentes para este sitio (icono junto a la barra de direcciones) y vuelve a pulsar «Sincronizar ahora» o «Reintentar».';

let gisLoadPromise: Promise<void> | null = null;

export function getGoogleOAuthClientId(): string | undefined {
  return (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined)?.trim() || undefined;
}

export function isGisConfigured(): boolean {
  return !!getGoogleOAuthClientId();
}

export async function loadGoogleIdentityServices(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (window.google?.accounts?.oauth2) return;

  if (!gisLoadPromise) {
    gisLoadPromise = new Promise((resolve, reject) => {
      const id = 'script-google-gsi-client';
      const existing = document.getElementById(id);
      if (existing) {
        const wait = () => {
          if (window.google?.accounts?.oauth2) resolve();
          else setTimeout(wait, 30);
        };
        wait();
        return;
      }
      const s = document.createElement('script');
      s.id = id;
      s.src = GIS_SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisLoadPromise = null;
        reject(new Error('No se pudo cargar Google Identity Services'));
      };
      document.head.appendChild(s);
    });
  }

  return gisLoadPromise;
}

function mapGisCallbackError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('popup') || m.includes('blocked') || m.includes('failed to open')) {
    return DRIVE_POPUP_BLOCKED_MESSAGE;
  }
  return raw;
}

/**
 * Obtiene un access_token de Google con permisos de Drive.
 * @param interactive - si true, fuerza consentimiento (solo debe usarse tras un clic del usuario; si no, el popup suele bloquearse).
 */
export async function requestDriveAccessTokenWithGis(interactive: boolean): Promise<string> {
  const clientId = getGoogleOAuthClientId();
  if (!clientId) {
    throw new Error('Falta VITE_GOOGLE_OAUTH_CLIENT_ID');
  }
  await loadGoogleIdentityServices();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error('Google Identity Services no está disponible');
  }

  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPES,
      callback: (resp: GisTokenResponse) => {
        if (resp.error) {
          const detail = resp.error_description ?? resp.error;
          reject(new Error(mapGisCallbackError(detail)));
          return;
        }
        if (!resp.access_token?.trim()) {
          reject(new Error('Google no devolvió access_token'));
          return;
        }
        resolve(resp.access_token.trim());
      }
    });
    try {
      client.requestAccessToken(interactive ? { prompt: 'consent' } : {});
    } catch (e) {
      reject(e instanceof Error ? new Error(mapGisCallbackError(e.message)) : e);
    }
  });
}
