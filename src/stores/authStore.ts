import type { Session } from '@supabase/supabase-js';
import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';
import { ensureDriveFolders } from '../services/driveService';
import { SESSION_EXPIRED } from '../utils/supabaseAuthErrors';
import { useToastStore } from './toastStore';
const LOGO_BUCKET = ((import.meta.env.VITE_LOGO_BUCKET as string | undefined)?.trim() || 'ctpat-logs');

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
const GOOGLE_PROVIDER_TOKEN_SAVED_AT_KEY = 'ts_google_provider_token_saved_at_v1';
/** Access token de Google ~1 h; usar uno caducado provoca 401 en Drive y el mensaje de «reconectar». */
const GOOGLE_ACCESS_TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

function decodeGoogleAccessTokenExpSec(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** true = no usar este token para Drive (caducado o caché sin referencia de tiempo). */
function shouldDiscardGoogleAccessToken(token: string, savedAtMs: number | null): boolean {
  const expSec = decodeGoogleAccessTokenExpSec(token);
  const nowSec = Math.floor(Date.now() / 1000);
  if (expSec != null) {
    return nowSec >= expSec - 120;
  }
  if (savedAtMs == null || !Number.isFinite(savedAtMs)) {
    return true;
  }
  return Date.now() - savedAtMs > GOOGLE_ACCESS_TOKEN_MAX_AGE_MS;
}

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

/** Margen antes del vencimiento del JWT para renovar (evita 401 en llamadas largas o pestaña inactiva). */
export const JWT_REFRESH_SKEW_SEC = 300;

/** Si falta `exp` o caduca en menos de `skewSec`, hay que refrescar. */
function shouldRefreshAccessToken(accessToken: string | undefined, skewSec = JWT_REFRESH_SKEW_SEC): boolean {
  const exp = accessTokenExp(accessToken);
  if (exp == null) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp - now < skewSec;
}

/** Normaliza metadata/BD al nombre de archivo en public/ y en assets del PDF */
export function normalizeServiceLogoFile(v: string | null): string {
  if (!v) return 'logo.png';
  const s = v.toString().toLowerCase();
  if (s.endsWith('.png') || s.endsWith('.jpg') || s.endsWith('.jpeg')) return s;
  if (s.includes('caterpillar')) return 'caterpillar.png';
  if (s.includes('komatsu')) return 'komatsu.png';
  if (s.includes('john_deere') || s.includes('john')) return 'john_deere.png';
  if (s.includes('danfoss')) return 'danfoss.png';
  // Permite logos arbitrarios: si no trae extensión, asumimos PNG.
  return `${s}.png`;
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
          force || !s0.access_token || shouldRefreshAccessToken(s0.access_token, JWT_REFRESH_SKEW_SEC);

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
        try {
          localStorage.setItem(GOOGLE_PROVIDER_TOKEN_SAVED_AT_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
      }
    },
    getGoogleProviderTokenSavedAtMs(): number | null {
      try {
        const raw = localStorage.getItem(GOOGLE_PROVIDER_TOKEN_SAVED_AT_KEY);
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    getGoogleProviderTokenFallback(userId: string | null | undefined): string | null {
      if (!userId) return null;
      const uid = localStorage.getItem(GOOGLE_PROVIDER_TOKEN_UID_KEY);
      const t = localStorage.getItem(GOOGLE_PROVIDER_TOKEN_KEY);
      if (uid !== userId || typeof t !== 'string' || t.length === 0) return null;

      let savedAt = this.getGoogleProviderTokenSavedAtMs();
      if (savedAt == null) {
        savedAt = Date.now();
        try {
          localStorage.setItem(GOOGLE_PROVIDER_TOKEN_SAVED_AT_KEY, String(savedAt));
        } catch {
          /* ignore */
        }
      }
      if (shouldDiscardGoogleAccessToken(t, savedAt)) {
        this.clearGoogleProviderTokenCache();
        return null;
      }
      return t;
    },
    clearGoogleProviderTokenCache() {
      localStorage.removeItem(GOOGLE_PROVIDER_TOKEN_KEY);
      localStorage.removeItem(GOOGLE_PROVIDER_TOKEN_UID_KEY);
      try {
        localStorage.removeItem(GOOGLE_PROVIDER_TOKEN_SAVED_AT_KEY);
      } catch {
        /* ignore */
      }
    },

    /**
     * Token de Google para Drive API: solo sesión Supabase OAuth (`provider_token`) + caché local.
     * Tras `refreshSession`, a veces no viene `provider_token`; el caché evita perder Drive hasta el próximo login.
     */
    async ensureGoogleDriveAccessTokenForApi(): Promise<string> {
      const uid = this.userId;
      if (!uid) {
        throw new Error('Debes iniciar sesión para usar Google Drive.');
      }

      await this.refreshSessionForApi({ force: true });
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const fromSession = this.getProviderTokenFromSession(session);
      const savedAt = this.getGoogleProviderTokenSavedAtMs();

      if (fromSession && !shouldDiscardGoogleAccessToken(fromSession, savedAt)) {
        this.googleAccessToken = fromSession;
        this.rememberGoogleProviderToken(uid, fromSession);
        return fromSession;
      }
      if (fromSession && shouldDiscardGoogleAccessToken(fromSession, savedAt)) {
        this.clearGoogleProviderTokenCache();
        this.googleAccessToken = null;
      }

      const fromFallback = this.getGoogleProviderTokenFallback(uid);
      if (fromFallback) {
        this.googleAccessToken = fromFallback;
        return fromFallback;
      }

      const mem = this.googleAccessToken;
      if (mem && !shouldDiscardGoogleAccessToken(mem, this.getGoogleProviderTokenSavedAtMs())) {
        return mem;
      }
      if (mem) {
        this.googleAccessToken = null;
        this.clearGoogleProviderTokenCache();
      }

      throw new Error(
        'No hay token de Google para Drive. Cierra sesión y vuelve a entrar con Google (acepta permisos de Drive al iniciar).'
      );
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
    async uploadServiceLogo(file: File): Promise<string> {
      if (!this.userId) throw new Error('No hay usuario autenticado.');
      const rawName = file.name.toLowerCase();
      const ext = rawName.endsWith('.jpg') || rawName.endsWith('.jpeg') ? 'jpg' : 'png';
      const objectPath = `logos/${this.userId}.${ext}`;

      // Asegura que exista user_drive_config antes de actualizar service_logo_file.
      await this.ensureDriveConfigIfNeeded();

      const { error: upErr } = await supabase.storage.from(LOGO_BUCKET).upload(objectPath, file, {
        upsert: true,
        contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png'
      });
      if (upErr) throw new Error(`No se pudo subir logo: ${upErr.message}`);

      const { error: cfgErr } = await supabase
        .from('user_drive_config')
        .update({ service_logo_file: objectPath })
        .eq('user_id', this.userId);
      if (cfgErr) throw new Error(`No se pudo guardar logo en configuración: ${cfgErr.message}`);

      this.serviceLogoFile = objectPath;
      return objectPath;
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
          /* sin token OAuth en sesión */
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
        // Si hay internet, no conservamos cache para evitar bucles 401/Invalid JWT.
        if (navigator.onLine) {
          this.isSignedIn = false;
          this.userId = null;
          this.email = null;
          this.displayName = null;
          this.googleAccessToken = null;
          this.serviceLogoFile = null;
          localStorage.removeItem(AUTH_CACHED_USER_ID_KEY);
          this.clearGoogleProviderTokenCache();
        } else {
          this.isSignedIn = !!this.userId;
          this.googleAccessToken = null;
          if (this.userId) {
            this.scheduleDriveConfigRetry();
          }
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

