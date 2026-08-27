import { defineStore } from 'pinia';

const TICKET_KEY = 'ts_ctpat_login_ticket_v1';

export type TurnstileStatus = 'idle' | 'widget' | 'verifying' | 'passed' | 'failed';

function readTicket(): string | null {
  try {
    return sessionStorage.getItem(TICKET_KEY);
  } catch {
    return null;
  }
}

function writeTicket(ticket: string): void {
  try {
    sessionStorage.setItem(TICKET_KEY, ticket);
  } catch {
    /* ignore */
  }
}

function clearTicket(): void {
  try {
    sessionStorage.removeItem(TICKET_KEY);
  } catch {
    /* ignore */
  }
}

export const useTurnstileStore = defineStore('turnstile', {
  state: (): { status: TurnstileStatus; error: string | null; loginTicket: string | null } => ({
    status: 'idle',
    error: null,
    loginTicket: null
  }),
  getters: {
    isPassed: (s) => s.status === 'passed' && Boolean(s.loginTicket || readTicket()),
    siteKey: () => (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() ?? ''
  },
  actions: {
    hydrate() {
      if (!this.siteKey) {
        this.status = 'failed';
        this.error = 'Falta VITE_TURNSTILE_SITE_KEY en el entorno de la app.';
        return;
      }
      const t = readTicket();
      if (t) {
        this.loginTicket = t;
        this.status = 'passed';
        this.error = null;
        return;
      }
      this.status = 'widget';
      this.error = null;
    },
    resetWidget() {
      clearTicket();
      this.loginTicket = null;
      this.status = this.siteKey ? 'widget' : 'failed';
      this.error = this.siteKey ? null : 'Falta VITE_TURNSTILE_SITE_KEY en el entorno de la app.';
    },
    fail(message: string) {
      clearTicket();
      this.loginTicket = null;
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
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          loginTicket?: string;
        } | null;
        if (!res.ok || !body?.ok || !body.loginTicket) {
          this.status = 'failed';
          this.error = body?.error ?? `Cloudflare rechazó la verificación (HTTP ${res.status}).`;
          clearTicket();
          this.loginTicket = null;
          return false;
        }
        writeTicket(body.loginTicket);
        this.loginTicket = body.loginTicket;
        this.status = 'passed';
        this.error = null;
        return true;
      } catch (e) {
        this.status = 'failed';
        this.error = e instanceof Error ? e.message : 'No se pudo verificar con el servidor.';
        clearTicket();
        this.loginTicket = null;
        return false;
      }
    },
    /** Consume el ticket en el servidor (one-time). Obligatorio antes de OAuth. */
    async consumeLoginTicket(): Promise<void> {
      const ticket = this.loginTicket || readTicket();
      if (!ticket) {
        this.resetWidget();
        throw new Error('Primero completa la verificación de Cloudflare.');
      }
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
      const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
      if (!baseUrl || !anonKey) {
        throw new Error('Falta configuración de Supabase.');
      }
      const res = await fetch(`${baseUrl}/functions/v1/verify-turnstile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`
        },
        body: JSON.stringify({ action: 'consume', loginTicket: ticket })
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      clearTicket();
      this.loginTicket = null;
      if (!res.ok || !body?.ok) {
        this.resetWidget();
        throw new Error(body?.error ?? 'Ticket de verificación inválido o expirado.');
      }
      this.status = 'widget';
    },
    assertPassed(): void {
      if (this.status === 'passed' && (this.loginTicket || readTicket())) return;
      this.resetWidget();
      throw new Error('Primero completa la verificación de Cloudflare.');
    }
  }
});
