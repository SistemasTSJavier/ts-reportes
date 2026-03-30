/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_SITE_URL?: string;
  readonly VITE_LOGO_BUCKET?: string;
  /** Client ID OAuth 2.0 (tipo Web) — mismo proyecto que Supabase Auth → Google */
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
