import { defineStore } from 'pinia';

const PASSED_KEY = 'ts_ctpat_turnstile_ok_v1';
const PASSED_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type TurnstileStatus = 'idle' | 'widget' | 'verifying' | 'passed' | 'failed';

function readPassedUntil(): number {
  try {
    const raw = localStorage.getItem(PASSED_KEY) ?? sessionStorage.getItem(PASSED_KEY);
    const n = raw ? Number(raw) : 0;
    if (Number.isFinite(n) && n > 0) {
      if (localStorage.getItem(PASSED_KEY) == null) {
        writePassedUntil(n);
        sessionStorage.removeItem(PASSED_KEY);
      }
      return n;
    }
    return 0;
  } catch {
    return 0;
  }
}

function writePassedUntil(until: number): void {
  try {
    localStorage.setItem(PASSED_KEY, String(until));
    sessionStorage.removeItem(PASSED_KEY);
  } catch {
    /* ignore */
  }
}

function clearPassed(): void {
  try {
    localStorage.removeItem(PASSED_KEY);
    sessionStorage.removeItem(PASSED_KEY);
  } catch {
    /* ignore */
  }
}

export const useTurnstileStore = defineStore('turnstile', {
  state: (): { status: TurnstileStatus; error: string | null } => ({
    status: 'idle',
    error: null
  }),
  getters: {
    isPassed: (s) => s.status === 'passed',
    siteKey: () => (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() ?? ''
  },
  actions: {
    hydrate() {
      if (!this.siteKey) {
        this.status = 'failed';
        this.error = 'Falta VITE_TURNSTILE_SITE_KEY en el entorno de la app.';
        return;
      }
      if (readPassedUntil() > Date.now()) {
        this.status = 'passed';
        this.error = null;
        return;
      }
      this.status = 'widget';
      this.error = null;
    },
    resetWidget() {
      clearPassed();
      this.status = this.siteKey ? 'widget' : 'failed';
      this.error = this.siteKey ? null : 'Falta VITE_TURNSTILE_SITE_KEY en el entorno de la app.';
    },
    fail(message: string) {
      clearPassed();
      this.status = 'failed';
      this.error = message;
    },
    async verifyToken(token: string): Promise<boolean> {
      const trimmed = token.trim();
      if (!trimmed) {
        this.status = 'failed';
        this.error = 'No se recibió token de Cloudflare.';
        return false;
      }

      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
      const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
      if (!baseUrl || !anonKey) {
        this.status = 'failed';
        this.error = 'Falta configuración de Supabase.';
        return false;
      }

      this.status = 'verifying';
      this.error = null;

      try {
        const res = await fetch(`${baseUrl}/functions/v1/verify-turnstile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`
          },
          body: JSON.stringify({ token: trimmed })
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !body?.ok) {
          this.status = 'failed';
          this.error = body?.error ?? `Cloudflare rechazó la verificación (HTTP ${res.status}).`;
          clearPassed();
          return false;
        }
        writePassedUntil(Date.now() + PASSED_TTL_MS);
        this.status = 'passed';
        this.error = null;
        return true;
      } catch (e) {
        this.status = 'failed';
        this.error = e instanceof Error ? e.message : 'No se pudo verificar con el servidor.';
        clearPassed();
        return false;
      }
    },
    assertPassed(): void {
      if (this.status === 'passed' && readPassedUntil() > Date.now()) return;
      this.resetWidget();
      throw new Error('Primero completa la verificación de Cloudflare.');
    }
  }
});
