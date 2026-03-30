import type { Session } from '@supabase/supabase-js';
import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';
import { ensureDriveFolders } from '../services/driveService';
import {
  DRIVE_POPUP_BLOCKED_MESSAGE,
  isGisConfigured,
  requestDriveAccessTokenWithGis
} from '../services/googleIdentityDrive';
import { SESSION_EXPIRED } from '../utils/supabaseAuthErrors';
import { useToastStore } from './toastStore';

interface AuthState {
  isSignedIn: boolean;
  email: string | null;
  displayName: string | null;
  userId: string | null;
  loading: boolean;
  googleAccessToken: string | null;
  driveConfigReady: boolean;
  driveConfigRetryScheduled: boolean;
  /** Nombre de archivo del logo de servicio (p. ej. danfoss.png), desde user_drive_config */
  serviceLogoFile: string | null;
}

const AUTH_CACHED_USER_ID_KEY = 'ts_ctpat_cached_user_id_v1';
/** Supabase a veces omite `provider_token` tras refresh; respaldo solo para el mismo usuario. */
const GOOGLE_PROVIDER_TOKEN_KEY = 'ts_google_provider_token_v1';
const GOOGLE_PROVIDER_TOKEN_UID_KEY = 'ts_google_provider_token_uid_v1';

/**
 * Varios listeners (visibility + focus + cola sync) pueden llamar a refresh a la vez.
 * Dos `refreshSession()` concurrentes invalidan el refresh token del otro → fallos y 401 Invalid JWT.
 */
let refreshSessionForApiMutex: Promise<Session | null> | null = null;

/** `exp` del JWT (segundos UNIX). */
function accessTokenExp(accessToken: string | undefined): number | null {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Si falta `exp` o caduca en menos de `skewSec`, hay que refrescar. */
function shouldRefreshAccessToken(accessToken: string | undefined, skewSec = 120): boolean {
  const exp = accessTokenExp(accessToken);
  if (exp == null) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp - now < skewSec;
}

/** Normaliza metadata/BD al nombre de archivo en public/ y en assets del PDF */
export function normalizeServiceLogoFile(v: string | null): string {
  if (!v) return 'caterpillar.png';
  const s = v.toString().toLowerCase();
  if (s.endsWith('.png') || s.endsWith('.jpg') || s.endsWith('.jpeg')) return v.toString();
  if (s.includes('caterpillar')) return 'caterpillar.png';
  if (s.includes('komatsu')) return 'komatsu.png';
  if (s.includes('john_deere') || s.includes('john')) return 'john_deere.png';
  if (s.includes('danfoss')) return 'danfoss.png';
  return 'caterpillar.png';
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    isSignedIn: false,
    email: null,
    displayName: null,
    userId: localStorage.getItem(AUTH_CACHED_USER_ID_KEY),
    loading: false,
    googleAccessToken: null,
    driveConfigReady: false,
    driveConfigRetryScheduled: false,
    serviceLogoFile: null
  }),
  actions: {
    /**
     * Renueva access_token antes de RPC, REST o Edge Function (evita 401 Invalid JWT).
     * Mantiene alineado provider_token de Google con la misma lógica que la cola de sync.
     * Las llamadas concurrentes comparten una sola promesa (mutex) para no tumbar el refresh token.
     */
    async refreshSessionForApi(options?: { force?: boolean }): Promise<Session | null> {
      if (!refreshSessionForApiMutex) {
        refreshSessionForApiMutex = this.refreshSessionForApiInner(options).finally(() => {
          refreshSessionForApiMutex = null;
        });
      }
      return refreshSessionForApiMutex;
    },
    /**
     * `force`: siempre llama a `refreshSession` si hay refresh_token (p. ej. tras 401 en Edge Function).
     * Si no, solo refresca cuando el access token falta o está a punto de caducar (evita rotar tokens en cada acción).
     */
    async refreshSessionForApiInner(options?: { force?: boolean }): Promise<Session | null> {
      const force = options?.force ?? false;
      try {
        const {
          data: { session: s0 }
        } = await supabase.auth.getSession();
        if (!s0?.user) return null;

        const needsRefresh =
          force || !s0.access_token || shouldRefreshAccessToken(s0.access_token, 120);

        let session: Session | null = s0;

        if (needsRefresh) {
          const rt = s0.refresh_token;
          if (!rt) return null;
          const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession({
            refresh_token: rt
          });
          if (refreshErr) {
            console.warn('refreshSessionForApi', refreshErr.message);
            return null;
          }
          session = refreshed.session ?? null;
          if (!session?.user) return null;
        }

        const uid = session.user.id;
        const googleFromSession = this.getProviderTokenFromSession(session);
        const googleFromInitial = this.getProviderTokenFromSession(s0);
        const google =
          googleFromSession ??
          googleFromInitial ??
          this.getGoogleProviderTokenFallback(uid) ??
          null;
        this.googleAccessToken = google;
        if (google) this.rememberGoogleProviderToken(uid, google);

        const gu1 = await supabase.auth.getUser();
        if (gu1.error || !gu1.data.user) {
          console.warn('getUser tras preparar sesión', gu1.error?.message);
          const { data: cur } = await supabase.auth.getSession();
          const rtRecover = cur.session?.refresh_token;
          if (!rtRecover) return null;
          const { data: refreshed2, error: e2 } = await supabase.auth.refreshSession({
            refresh_token: rtRecover
          });
          if (e2 || !refreshed2.session?.user) return null;
          const s = refreshed2.session;
          const uid2 = s.user.id;
          this.googleAccessToken =
            this.getProviderTokenFromSession(s) ??
            this.getGoogleProviderTokenFallback(uid2) ??
            this.googleAccessToken;
          if (this.googleAccessToken) this.rememberGoogleProviderToken(uid2, this.googleAccessToken);
          const gu2 = await supabase.auth.getUser();
          if (gu2.error || !gu2.data.user) return null;
        }

        const {
          data: { session: latest }
        } = await supabase.auth.getSession();
        return latest ?? session;
      } catch (e) {
        console.error('refreshSessionForApi', e);
        return null;
      }
    },
    getProviderTokenFromSession(session: unknown): string | null {
      const token = (session as any)?.provider_token;
      return typeof token === 'string' && token.length > 0 ? token : null;
    },
    /** Guarda el token de Google OAuth para Drive cuando la sesión ya no lo trae (p. ej. tras refreshSession). */
    rememberGoogleProviderToken(userId: string | null | undefined, token: string | null | undefined) {
      if (!userId) return;
      if (typeof token === 'string' && token.length > 0) {
        localStorage.setItem(GOOGLE_PROVIDER_TOKEN_UID_KEY, userId);
        localStorage.setItem(GOOGLE_PROVIDER_TOKEN_KEY, token);
      }
    },
    getGoogleProviderTokenFallback(userId: string | null | undefined): string | null {
      if (!userId) return null;
      const uid = localStorage.getItem(GOOGLE_PROVIDER_TOKEN_UID_KEY);
      const t = localStorage.getItem(GOOGLE_PROVIDER_TOKEN_KEY);
      if (uid === userId && typeof t === 'string' && t.length > 0) return t;
      return null;
    },
    clearGoogleProviderTokenCache() {
      localStorage.removeItem(GOOGLE_PROVIDER_TOKEN_KEY);
      localStorage.removeItem(GOOGLE_PROVIDER_TOKEN_UID_KEY);
    },

    /**
     * Token de Google para Drive API: prioriza GIS (recomendado por Google para web),
     * luego `provider_token` de Supabase / caché local.
     * El popup de GIS solo debe abrirse tras un gesto del usuario (`fromUserGesture`); si no, el navegador lo bloquea.
     * @param options.interactive - consentimiento GIS explícito (requiere fromUserGesture).
     */
    async ensureGoogleDriveAccessTokenForApi(
      options?: { interactive?: boolean; fromUserGesture?: boolean }
    ): Promise<string> {
      const interactive = options?.interactive ?? false;
      const fromUserGesture = options?.fromUserGesture === true;
      const uid = this.userId;
      if (!uid) {
        throw new Error('Debes iniciar sesión para usar Google Drive.');
      }

      if (isGisConfigured()) {
        if (interactive) {
          if (!fromUserGesture) {
            throw new Error(
              'Google Drive requiere autorizar en esta pantalla. Pulsa «Sincronizar ahora» o «Reintentar» en Inicio.'
            );
          }
          const token = await requestDriveAccessTokenWithGis(true);
          this.googleAccessToken = token;
          this.rememberGoogleProviderToken(uid, token);
          return token;
        }
        try {
          const token = await requestDriveAccessTokenWithGis(false);
          this.googleAccessToken = token;
          this.rememberGoogleProviderToken(uid, token);
          return token;
        } catch (e1) {
          console.warn('[Drive] GIS sin prompt:', e1);
          if (fromUserGesture) {
            try {
              const token = await requestDriveAccessTokenWithGis(true);
              this.googleAccessToken = token;
              this.rememberGoogleProviderToken(uid, token);
              return token;
            } catch (e2) {
              console.warn('[Drive] GIS con consentimiento:', e2);
            }
          }
        }
      }

      await this.refreshSessionForApi({ force: true });
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const fromSession = this.getProviderTokenFromSession(session);
      const token =
        fromSession ?? this.googleAccessToken ?? this.getGoogleProviderTokenFallback(uid) ?? null;

      if (!token) {
        throw new Error(
          isGisConfigured()
            ? fromUserGesture
              ? DRIVE_POPUP_BLOCKED_MESSAGE
              : 'No se pudo acceder a Google Drive en segundo plano. Pulsa «Sincronizar ahora» o «Reintentar» en Inicio para autorizar.'
            : 'No hay token de Google para Drive. Añade VITE_GOOGLE_OAUTH_CLIENT_ID (Client ID web) o vuelve a iniciar sesión con Google y acepta permisos de Drive.'
        );
      }
      this.googleAccessToken = token;
      this.rememberGoogleProviderToken(uid, token);
      return token;
    },
    async getDriveConfigRow(userId: string) {
      const { data, error } = await supabase
        .from('user_drive_config')
        .select('pdf_folder_id, images_folder_id, service_logo_file')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
    scheduleDriveConfigRetry() {
      if (this.driveConfigRetryScheduled) return;
      this.driveConfigRetryScheduled = true;
      const retry = () => {
        window.removeEventListener('online', retry);
        this.driveConfigRetryScheduled = false;
        void this.ensureDriveConfigIfNeeded();
      };
      window.addEventListener('online', retry, { once: true });
    },
    async ensureDriveConfigIfNeeded() {
      if (!this.userId) return;
      try {
        const existing = await this.getDriveConfigRow(this.userId);
        if (existing) {
          this.driveConfigReady = true;
          this.serviceLogoFile = existing.service_logo_file ?? null;
          return;
        }
      } catch (e) {
        console.error('Error consultando user_drive_config:', e);
      }

      let token = this.googleAccessToken;
      if (!token) {
        const {
          data: { session }
        } = await supabase.auth.getSession();
        token = this.getProviderTokenFromSession(session);
      }

      // En algunas restauraciones de sesión en móvil, provider_token no llega.
      // Intentamos refrescar sesión una vez para recuperarlo.
      if (!token) {
        try {
          const { data: refreshed } = await supabase.auth.refreshSession();
          token = this.getProviderTokenFromSession(refreshed?.session);
        } catch (e) {
          console.error('Error refrescando sesión para token Google:', e);
        }
      }

      if (!token) {
        try {
          token = await this.ensureGoogleDriveAccessTokenForApi();
        } catch {
          /* sin GIS / usuario canceló */
        }
      }

      if (!token) {
        this.driveConfigReady = false;
        this.scheduleDriveConfigRetry();
        return;
      }

      this.googleAccessToken = token;
      try {
        await this.ensureUserDriveConfig(token);
      } catch (e) {
        console.error('Error asegurando configuración Drive:', e);
        this.driveConfigReady = false;
        this.scheduleDriveConfigRetry();
      }
    },
    async initSession() {
      this.loading = true;
      this.driveConfigReady = false;
      try {
        const {
          data: { session }
        } = await supabase.auth.getSession();

        if (session?.user) {
          this.isSignedIn = true;
          this.userId = session.user.id ?? null;
          this.email = session.user.email ?? null;
          this.displayName =
            (session.user.user_metadata?.full_name as string | undefined) ??
            (session.user.user_metadata?.name as string | undefined) ??
            this.email;
          if (this.userId) {
            localStorage.setItem(AUTH_CACHED_USER_ID_KEY, this.userId);
          }
          const uid = session.user.id ?? null;
          const fromSession = this.getProviderTokenFromSession(session);
          const token =
            fromSession ?? this.getGoogleProviderTokenFallback(uid ?? undefined);
          this.googleAccessToken = typeof token === 'string' && token.length > 0 ? token : null;
          if (fromSession && uid) this.rememberGoogleProviderToken(uid, fromSession);
          await this.ensureDriveConfigIfNeeded();
          if (!this.serviceLogoFile && session.user) {
            const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
            const candidate =
              (meta.service_logo_file as string | undefined) ??
              (meta.service_logo as string | undefined) ??
              (meta.service_code as string | undefined) ??
              (meta.service as string | undefined) ??
              null;
            if (candidate) {
              this.serviceLogoFile = normalizeServiceLogoFile(candidate);
            }
          }
        } else {
          this.isSignedIn = false;
          this.userId = null;
          this.email = null;
          this.displayName = null;
          this.googleAccessToken = null;
          this.serviceLogoFile = null;
          localStorage.removeItem(AUTH_CACHED_USER_ID_KEY);
          this.clearGoogleProviderTokenCache();
        }
      } catch (e) {
        // Si falla por CORS/red, no dejamos la UI bloqueada en loading.
        console.error('Error initSession:', e);
        // En modo offline mantenemos cache de identidad para permitir cola local.
        this.isSignedIn = !!this.userId;
        this.googleAccessToken = null;
        if (this.userId) {
          this.scheduleDriveConfigRetry();
        }
      } finally {
        this.loading = false;
      }
    },
    /**
     * Si el usuario no tiene user_drive_config, crea las carpetas en Google Drive
     * (TS REPORTES > PDFs, Evidencias) y guarda los IDs en Supabase.
     */
    async ensureUserDriveConfig(accessToken: string) {
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) return;

      const existing = await this.getDriveConfigRow(userId);

      if (existing) {
        this.driveConfigReady = true;
        return;
      }

      try {
        const { pdfFolderId, imagesFolderId } = await ensureDriveFolders(accessToken);

        // Intentar obtener el "servicio" desde user_metadata para asignar el logo correcto.
        // Claves soportadas (puedes ajustar según cómo crees el usuario en Supabase):
        // - service_logo_file
        // - service_logo
        // - service_code / service
        const meta = (session?.user?.user_metadata ?? {}) as Record<string, unknown>;
        const candidate =
          (meta.service_logo_file as string | undefined) ??
          (meta.service_logo as string | undefined) ??
          (meta.service_code as string | undefined) ??
          (meta.service as string | undefined) ??
          null;

        const logoFile = normalizeServiceLogoFile(candidate);

        const { error } = await supabase.from('user_drive_config').insert({
          user_id: userId,
          pdf_folder_id: pdfFolderId,
          images_folder_id: imagesFolderId,
          service_logo_file: logoFile
        });

        if (error) throw error;
        this.driveConfigReady = true;
        this.serviceLogoFile = logoFile;
      } catch (e) {
        console.error('Error creando carpetas en Drive:', e);
        this.driveConfigReady = false;
      }
    },
    async signInWithGoogle() {
      this.loading = true;
      // En despliegues (Vercel) evitamos que OAuth quede apuntando a `localhost`
      // usando una URL fija configurable desde Vercel.
      const rawSiteUrl =
        (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;
      // Normaliza para evitar mismatch en redirect URLs (por ejemplo, slash final).
      const redirectTo = rawSiteUrl.replace(/\/$/, '');

      try {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo,
            scopes:
              'openid profile email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive',
            queryParams: {
              access_type: 'offline',
              prompt: 'consent'
            }
          }
        });

        if (error) {
          // eslint-disable-next-line no-console
          console.error('Error signInWithGoogle', error);
        }
      } catch (e) {
        console.error('Error signInWithGoogle:', e);
      } finally {
        this.loading = false;
      }
    },
    async signOut() {
      await supabase.auth.signOut();
      this.isSignedIn = false;
      this.userId = null;
      this.email = null;
      this.displayName = null;
      this.googleAccessToken = null;
      this.serviceLogoFile = null;
      localStorage.removeItem(AUTH_CACHED_USER_ID_KEY);
      this.clearGoogleProviderTokenCache();
    },
    /**
     * Cierra sesión y avisa con un mensaje claro (sin códigos 401/JWT crudos).
     * Usar cuando la API indique sesión inválida o expirada.
     */
    async signOutDueToExpiredSession() {
      const toast = useToastStore();
      toast.error(SESSION_EXPIRED.title, SESSION_EXPIRED.message);
      await this.signOut();
    }
  }
});

