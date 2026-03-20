import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';

export type SyncKind = 'create_registro_and_generate' | 'generate_pdf';

export interface CreateRegistroAndGeneratePayload {
  userId: string;
  // Payload para insertar en `registros_ctpat`, pero SIN `folio_pdf` (lo generamos en sync).
  insertPayloadBase: Record<string, unknown>;
}

export interface GeneratePdfPayload {
  registroId: string;
  folio?: string;
}

type SyncPayload = CreateRegistroAndGeneratePayload | GeneratePdfPayload;

interface SyncItem {
  id: string; // id local para la cola (no necesariamente el id de BD)
  kind: SyncKind;
  payload: SyncPayload;
  status: 'pending' | 'processing' | 'done' | 'error';
  lastError?: string;
  updatedAt: string;
}

interface SyncState {
  queue: SyncItem[];
  syncing: boolean;
  history: SyncItem[];
}

const STORAGE_KEY = 'ts_ctpat_sync_queue_v1';
const HISTORY_KEY = 'ts_ctpat_sync_history_v1';

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    queue: [],
    syncing: false,
    history: []
  }),
  actions: {
    loadFromStorage() {
      const raw = localStorage.getItem(STORAGE_KEY);
      const rawHistory = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SyncItem[];
        // Backward-compatibilidad:
        // si viene un item viejo sin `kind`, asumimos el formato anterior (generate_pdf)
        this.queue = Array.isArray(parsed)
          ? parsed.map((it: any) => {
              if (it?.kind) return it as SyncItem;
              // Estructura antigua: { id, payload: { id, createdAt, folio }, status... }
              const registroId = it?.payload?.id;
              const folio = it?.payload?.folio;
              return {
                id: it?.id ?? registroId ?? String(Date.now()),
                kind: 'generate_pdf',
                payload: { registroId, folio } satisfies GeneratePdfPayload,
                status: it?.status ?? 'pending',
                lastError: it?.lastError,
                updatedAt: it?.updatedAt ?? new Date().toISOString()
              } satisfies SyncItem;
            })
          : [];
      }
      if (rawHistory) {
        this.history = JSON.parse(rawHistory);
      }
    },
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    },
    enqueueCreateRegistroAndGenerate(payload: CreateRegistroAndGeneratePayload) {
      const now = new Date().toISOString();
      const id = `create_${payload.userId}_${Date.now()}`;
      const item: SyncItem = {
        id,
        kind: 'create_registro_and_generate',
        payload,
        status: 'pending',
        updatedAt: now
      };
      this.queue.push(item);
      this.persist();
    },
    enqueueGeneratePdf(payload: GeneratePdfPayload) {
      const now = new Date().toISOString();
      const id = `pdf_${payload.registroId}`;
      const item: SyncItem = {
        id,
        kind: 'generate_pdf',
        payload,
        status: 'pending',
        updatedAt: now
      };
      this.queue.push(item);
      this.persist();
    },
    async processQueue() {
      if (this.syncing || this.queue.length === 0) return;
      if (!navigator.onLine) return;

      this.syncing = true;
      const functionsBaseUrl =
        import.meta.env.VITE_SUPABASE_FUNCTIONS_URL ??
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

      try {
        const {
          data: { session }
        } = await supabase.auth.getSession();
        // @ts-expect-error provider_token está presente cuando el proveedor es OAuth (Google)
        const accessToken: string | undefined = (session as any)?.provider_token;
        // JWT de Supabase del usuario autenticado (necesario para que la Edge Function autorice la llamada)
        const supabaseAccessTokenCandidate: unknown =
          (session as any)?.access_token ??
          (session as any)?.accessToken ??
          (session as any)?.token?.access_token;

        const supabaseAccessToken =
          typeof supabaseAccessTokenCandidate === 'string'
            ? supabaseAccessTokenCandidate
            : undefined;

        const looksLikeJwt = (t: string | undefined): boolean => {
          if (!t) return false;
          // Un JWT típico tiene 3 secciones separadas por '.'
          return t.split('.').length === 3;
        };

        for (const item of this.queue) {
          if (item.status !== 'pending') continue;
          item.status = 'processing';
          item.updatedAt = new Date().toISOString();
          this.persist();

          try {
            if (item.kind === 'generate_pdf') {
              if (!accessToken) {
                throw new Error(
                  'No hay token de Google disponible (provider_token). Cierra sesión y vuelve a iniciar con Google.'
                );
              }
              if (!supabaseAccessToken) {
                throw new Error(
                  'No hay token JWT de Supabase disponible. Inicia sesión nuevamente con Google.'
                );
              }
              if (!looksLikeJwt(supabaseAccessToken)) {
                throw new Error(
                  `El token enviado no parece JWT de Supabase (empieza con: ${supabaseAccessToken.slice(
                    0,
                    12
                  )}).`
                );
              }

              const payload = item.payload as GeneratePdfPayload;
              const res = await fetch(`${functionsBaseUrl}/generate-ctpat-pdf`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${supabaseAccessToken}`
                },
                body: JSON.stringify({ registroId: payload.registroId, accessToken })
              });

              if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Error en Edge Function');
              }

              item.status = 'done';
              item.updatedAt = new Date().toISOString();
              this.history.unshift({ ...item });
            } else if (item.kind === 'create_registro_and_generate') {
              // 1) Generar folio
              const payload = item.payload as CreateRegistroAndGeneratePayload;

              const { data: folioData, error: folioErr } = await supabase.rpc('next_folio_ctpat', {
                p_user_id: payload.userId
              });

              if (folioErr || !folioData) {
                throw new Error(`No se pudo generar folio automático: ${folioErr?.message ?? 'sin detalle'}`);
              }

              const folioAuto = folioData as string;

              // 2) Insertar registro en BD
              const insertPayload = {
                ...payload.insertPayloadBase,
                folio_pdf: folioAuto,
                sync_status: 'pending'
              };

              const { data: inserted, error: insertErr } = await supabase
                .from('registros_ctpat')
                .insert(insertPayload)
                .select('id, created_at, folio_pdf')
                .single();

              if (insertErr || !inserted) {
                throw new Error(`Error insertando registro: ${insertErr?.message ?? 'sin detalle'}`);
              }

              // 3) Generar PDF (Edge Function) usando el token Google
              if (!accessToken) {
                throw new Error(
                  'Registro creado pero falta token Google (provider_token). Reintenta iniciando sesión con Google.'
                );
              }
              if (!supabaseAccessToken) {
                throw new Error(
                  'Registro creado pero falta el JWT de Supabase. Cierra sesión y vuelve a iniciar con Google.'
                );
              }
              if (!looksLikeJwt(supabaseAccessToken)) {
                throw new Error(
                  `El token enviado no parece JWT de Supabase (empieza con: ${supabaseAccessToken.slice(
                    0,
                    12
                  )}).`
                );
              }

              const res = await fetch(`${functionsBaseUrl}/generate-ctpat-pdf`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${supabaseAccessToken}`
                },
                body: JSON.stringify({ registroId: inserted.id, accessToken })
              });

              if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Error en Edge Function');
              }

              item.status = 'done';
              item.updatedAt = new Date().toISOString();
              this.history.unshift({
                ...item,
                payload: {
                  registroId: inserted.id,
                  folio: folioAuto
                } satisfies GeneratePdfPayload
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            item.status = 'error';
            item.lastError = message;
            item.updatedAt = new Date().toISOString();
            this.history.unshift({ ...item });
          }
        }

        this.queue = this.queue.filter((q) => q.status === 'pending' || q.status === 'error');
        this.persist();
      } finally {
        this.syncing = false;
      }
    },
    attachOnlineListener() {
      window.addEventListener('online', () => {
        void this.processQueue();
      });
    }
  }
});

