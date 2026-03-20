import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';
import { ensureDriveFolders } from '../services/driveService';

interface AuthState {
  isSignedIn: boolean;
  email: string | null;
  displayName: string | null;
  loading: boolean;
  googleAccessToken: string | null;
  driveConfigReady: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    isSignedIn: false,
    email: null,
    displayName: null,
    loading: false,
    googleAccessToken: null,
    driveConfigReady: false
  }),
  actions: {
    async initSession() {
      this.loading = true;
      this.driveConfigReady = false;
      try {
        const {
          data: { session }
        } = await supabase.auth.getSession();

        if (session?.user) {
          this.isSignedIn = true;
          this.email = session.user.email ?? null;
          this.displayName =
            (session.user.user_metadata?.full_name as string | undefined) ??
            (session.user.user_metadata?.name as string | undefined) ??
            this.email;
          // @ts-expect-error provider_token existe en la sesión cuando el proveedor es OAuth (Google)
          const token = (session as any).provider_token ?? null;
          this.googleAccessToken = token;

          // Crear carpetas en Drive automáticamente si aún no tiene config
          if (token) {
            await this.ensureUserDriveConfig(token);
          }
        } else {
          this.isSignedIn = false;
          this.email = null;
          this.displayName = null;
          this.googleAccessToken = null;
        }
      } catch (e) {
        // Si falla por CORS/red, no dejamos la UI bloqueada en loading.
        console.error('Error initSession:', e);
        this.isSignedIn = false;
        this.email = null;
        this.displayName = null;
        this.googleAccessToken = null;
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

      const { data: existing } = await supabase
        .from('user_drive_config')
        .select('pdf_folder_id, images_folder_id')
        .eq('user_id', userId)
        .maybeSingle();

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

        const normalizeLogoFile = (v: string | null): string => {
          if (!v) return 'caterpillar.png';
          const s = v.toString().toLowerCase();
          // Si ya viene como nombre de archivo
          if (s.endsWith('.png') || s.endsWith('.jpg') || s.endsWith('.jpeg')) return v.toString();
          if (s.includes('caterpillar')) return 'caterpillar.png';
          if (s.includes('komatsu')) return 'komatsu.png';
          if (s.includes('john_deere') || s.includes('john')) return 'john_deere.png';
          return 'caterpillar.png';
        };

        const { error } = await supabase.from('user_drive_config').insert({
          user_id: userId,
          pdf_folder_id: pdfFolderId,
          images_folder_id: imagesFolderId,
          service_logo_file: normalizeLogoFile(candidate)
        });

        if (error) throw error;
        this.driveConfigReady = true;
      } catch (e) {
        console.error('Error creando carpetas en Drive:', e);
        this.driveConfigReady = false;
      }
    },
    async signInWithGoogle() {
      this.loading = true;
      // En despliegues (Vercel) evitamos que OAuth quede apuntando a `localhost`
      // usando una URL fija configurable desde Vercel.
      const redirectTo =
        (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;

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
      this.email = null;
      this.displayName = null;
      this.googleAccessToken = null;
    }
  }
});

