import type { Session } from '@supabase/supabase-js';
import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';
import { ensureDriveFolders } from '../services/driveService';

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
  /**
   * Si es true, el JWT ya no es válido y hay que recargar la página (no basta con navegar en la SPA).
   */
  sessionRestartRequired: boolean;
}

const AUTH_CACHED_USER_ID_KEY = 'ts_ctpat_cached_user_id_v1';
/** Supabase a veces omite `provider_token` tras refresh; respaldo solo para el mismo usuario. */
const GOOGLE_PROVIDER_TOKEN_KEY = 'ts_google_provider_token_v1';
const GOOGLE_PROVIDER_TOKEN_UID_KEY = 'ts_google_provider_token_uid_v1';

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
    serviceLogoFile: null,
    sessionRestartRequired: false
  }),
  actions: {
    requireSessionRestart() {
      this.sessionRestartRequired = true;
    },
    clearSessionRestartRequired() {
      this.sessionRestartRequired = false;
    },
    /**
     * Renueva access_token antes de RPC, REST o Edge Function (evita 401 Invalid JWT).
     * Mantiene alineado provider_token de Google con la misma lógica que la cola de sync.
     */
    async refreshSessionForApi(): Promise<Session | null> {
      if (this.sessionRestartRequired) return null;
      try {
        const {
          data: { session: sessionInitial }
        } = await supabase.auth.getSession();

        const refreshToken = sessionInitial?.refresh_token;
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession(
          refreshToken ? { refresh_token: refreshToken } : undefined
        );
        if (refreshErr) {
          console.warn('refreshSessionForApi', refreshErr.message);
          if (sessionInitial?.user) this.requireSessionRestart();
          return null;
        }
        // No usar sessionInitial como sustituto del access_token: puede seguir caducado → 401 Invalid JWT.
        const session = refreshed.session;
        if (!session?.user) {
          if (sessionInitial?.user) this.requireSessionRestart();
          return null;
        }

        const uid = session.user.id;
        const googleFromRefresh = this.getProviderTokenFromSession(session);
        const googleFromInitial = this.getProviderTokenFromSession(sessionInitial);
        const google =
          googleFromRefresh ??
          googleFromInitial ??
          this.getGoogleProviderTokenFallback(uid) ??
          null;
        this.googleAccessToken = google;
        if (google) this.rememberGoogleProviderToken(uid, google);

        return session;
      } catch (e) {
        console.error('refreshSessionForApi', e);
        this.requireSessionRestart();
        return null;
      }
    },
    /**
     * Al volver a la pestaña / primer plano: renueva el JWT para evitar 401.
     */
    async refreshSessionOnForeground() {
      if (!this.isSignedIn || this.sessionRestartRequired) return;
      await this.refreshSessionForApi();
    },
    reloadApp() {
      window.location.reload();
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
      this.sessionRestartRequired = false;
      localStorage.removeItem(AUTH_CACHED_USER_ID_KEY);
      this.clearGoogleProviderTokenCache();
    }
  }
});

