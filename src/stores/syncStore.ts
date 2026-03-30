import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';
import { useAuthStore } from './authStore';
import { isSupabaseGatewayUnauthorized } from '../utils/supabaseAuthErrors';

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
  connectivity: 'online' | 'offline';
  retryAttempt: number;
  retryTimerId: number | null;
  periodicSyncTimerId: number | null;
}

const STORAGE_KEY = 'ts_ctpat_sync_queue_v1';
const HISTORY_KEY = 'ts_ctpat_sync_history_v1';
const IDB_NAME = 'ts_ctpat_sync_db_v1';
const IDB_STORE = 'kv';

/** IndexedDB no puede clonar Proxies (estado reactivo de Pinia/Vue). */
function cloneForIndexedDb<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Llama a la Edge Function con `fetch` y headers explícitos.
 * `supabase.functions.invoke` a veces no envía bien `Authorization` y la API responde
 * `401 Missing authorization header`.
 *
 * Refresco forzado al entrar + reintentos si la puerta devuelve 401 de sesión.
 */
async function invokeGenerateCtpatPdf(
  registroId: string,
  googleDriveAccessToken: string,
  _supabaseAccessTokenHint: string
): Promise<void> {
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  const auth = useAuthStore();

  /**
   * Siempre pedimos un access_token recién emitido antes de la Edge Function.
   * Si solo usáramos el JWT del inicio de processQueue, la puerta de enlace puede responder
   * 401 Invalid JWT aunque el token local parezca válido (desfase o rotación).
   */
  const freshFirst = await auth.refreshSessionForApi({ force: true });
  let jwt = freshFirst?.access_token ?? _supabaseAccessTokenHint;
  if (!jwt) {
    throw new Error('No hay sesión para generar el PDF. Inicia sesión de nuevo con Google.');
  }

  const runOnce = async (userJwt: string): Promise<void> => {
    const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
    if (!baseUrl) {
      throw new Error('Falta VITE_SUPABASE_URL.');
    }
    if (!anonKey) {
      throw new Error('Falta VITE_SUPABASE_ANON_KEY en el entorno de la app.');
    }
    const trimmedJwt = userJwt.trim();
    if (!trimmedJwt) {
      throw new Error('No hay token de sesión para llamar a la función.');
    }

    const url = `${baseUrl}/functions/v1/generate-ctpat-pdf`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedJwt}`,
        apikey: anonKey
      },
      body: JSON.stringify({
        registroId,
        accessToken: googleDriveAccessToken
      })
    });

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { message?: string; code?: number };
        const inner = j?.message ?? text;
        detail = `HTTP ${res.status}: ${inner}`;
      } catch {
        detail = text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`;
      }
      throw new Error(detail);
    }

    if (text) {
      let parsed: { ok?: boolean; error?: string };
      try {
        parsed = JSON.parse(text) as { ok?: boolean; error?: string };
      } catch {
        return;
      }
      if (parsed.ok === false) {
        throw new Error(parsed.error ?? 'Error en función');
      }
    }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await runOnce(jwt);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Reintento solo si el fallo es claramente el JWT de Supabase (401 gateway), no errores de Drive/PDF.
      // Nunca cerramos sesión aquí: el registro ya puede estar guardado; Drive/Google falla aparte.
      if (isSupabaseGatewayUnauthorized(message) && attempt < 2) {
        const recovered = await auth.refreshSessionForApi({ force: true });
        const next = recovered?.access_token;
        if (next) {
          jwt = next;
          continue;
        }
      }
      throw err;
    }
  }
}

function openSyncDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    openSyncDb()
      .then((db) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      })
      .catch(reject);
  });
}

function idbSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    openSyncDb()
      .then((db) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
      .catch(reject);
  });
}

function normalizeQueueItems(parsed: unknown): SyncItem[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((it: any) => {
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
  });
}

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    queue: [],
    syncing: false,
    history: [],
    connectivity: navigator.onLine ? 'online' : 'offline',
    retryAttempt: 0,
    retryTimerId: null,
    periodicSyncTimerId: null
  }),
  actions: {
    clearRetryTimer() {
      if (this.retryTimerId != null) {
        window.clearTimeout(this.retryTimerId);
        this.retryTimerId = null;
      }
    },
    async updateConnectivity() {
      // Híbrido para Android/PWA: `navigator.onLine` puede quedar desfasado.
      // 1) Si el SO reporta online, tomamos online.
      if (navigator.onLine) {
        this.connectivity = 'online';
        return;
      }

      // 2) Si reporta offline, validamos reachability real a Supabase con timeout.
      // Esto destraba casos donde el navegador marca offline erróneamente.
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal
        });
        this.connectivity = res.ok ? 'online' : 'offline';
      } catch {
        this.connectivity = 'offline';
      } finally {
        window.clearTimeout(timer);
      }
    },
    scheduleRetry() {
      this.clearRetryTimer();
      const ms = Math.min(60000, 5000 * 2 ** Math.max(0, this.retryAttempt - 1));
      this.retryTimerId = window.setTimeout(() => {
        void this.processQueue();
      }, ms);
    },
    async loadFromStorage() {
      try {
        const queueFromDb = await idbGet<SyncItem[]>(STORAGE_KEY);
        const historyFromDb = await idbGet<SyncItem[]>(HISTORY_KEY);

        if (queueFromDb) {
          this.queue = normalizeQueueItems(queueFromDb);
        }
        if (historyFromDb) {
          this.history = Array.isArray(historyFromDb) ? historyFromDb : [];
        }

        // Migración automática desde localStorage -> IndexedDB.
        if (!queueFromDb) {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            this.queue = normalizeQueueItems(JSON.parse(raw));
            await idbSet(STORAGE_KEY, cloneForIndexedDb(this.queue));
          }
        }
        if (!historyFromDb) {
          const rawHistory = localStorage.getItem(HISTORY_KEY);
          if (rawHistory) {
            this.history = JSON.parse(rawHistory);
            await idbSet(HISTORY_KEY, cloneForIndexedDb(this.history));
          }
        }
      } catch (e) {
        // Fallback a localStorage si IndexedDB no está disponible.
        console.warn('SyncStore: IndexedDB no disponible, usando localStorage', e);
        const raw = localStorage.getItem(STORAGE_KEY);
        const rawHistory = localStorage.getItem(HISTORY_KEY);
        this.queue = raw ? normalizeQueueItems(JSON.parse(raw)) : [];
        this.history = rawHistory ? JSON.parse(rawHistory) : [];
      }
    },
    async persist() {
      try {
        await Promise.all([
          idbSet(STORAGE_KEY, cloneForIndexedDb(this.queue)),
          idbSet(HISTORY_KEY, cloneForIndexedDb(this.history))
        ]);
      } catch (e) {
        // Fallback para navegadores restringidos.
        console.warn('SyncStore: error guardando en IndexedDB, usando localStorage', e);
      }
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
      void this.persist();
    },
    enqueueGeneratePdf(payload: GeneratePdfPayload) {
      const now = new Date().toISOString();
      const id = `pdf_${payload.registroId}`;
      const alreadyQueued = this.queue.some((q) => q.id === id && q.status !== 'done');
      if (alreadyQueued) {
        return;
      }
      const item: SyncItem = {
        id,
        kind: 'generate_pdf',
        payload,
        status: 'pending',
        updatedAt: now
      };
      this.queue.push(item);
      void this.persist();
    },
    async processQueue() {
      if (this.syncing || this.queue.length === 0) return;
      await this.updateConnectivity();
      if (this.connectivity !== 'online') return;

      this.syncing = true;
      let hadError = false;
      let hadSuccess = false;

      try {
        const authStore = useAuthStore();
        const session = await authStore.refreshSessionForApi();
        if (!session?.access_token) {
          return;
        }
        const supabaseJwt = session.access_token;

        const accessToken: string | undefined = authStore.googleAccessToken ?? undefined;

        for (const item of this.queue) {
          if (item.status !== 'pending') continue;
          item.status = 'processing';
          item.updatedAt = new Date().toISOString();
          await this.persist();

          try {
            if (item.kind === 'generate_pdf') {
              if (!accessToken) {
                throw new Error(
                  'No hay token de Google para Drive. Cierra sesión y vuelve a iniciar con Google y acepta el acceso a Google Drive.'
                );
              }

              const payload = item.payload as GeneratePdfPayload;
              await invokeGenerateCtpatPdf(payload.registroId, accessToken, supabaseJwt);

              item.status = 'done';
              item.lastError = undefined;
              item.updatedAt = new Date().toISOString();
              this.history.unshift({ ...item });
              hadSuccess = true;
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
                  'Registro creado pero falta token de Google para Drive. Cierra sesión, inicia de nuevo con Google y acepta el acceso a Drive.'
                );
              }

              await invokeGenerateCtpatPdf(inserted.id, accessToken, supabaseJwt);

              item.status = 'done';
              item.lastError = undefined;
              item.updatedAt = new Date().toISOString();
              this.history.unshift({
                ...item,
                payload: {
                  registroId: inserted.id,
                  folio: folioAuto
                } satisfies GeneratePdfPayload
              });
              hadSuccess = true;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            item.status = 'error';
            item.lastError = message;
            item.updatedAt = new Date().toISOString();
            this.history.unshift({ ...item });
            hadError = true;
          }
        }

        this.queue = this.queue.filter((q) => q.status === 'pending' || q.status === 'error');
        await this.persist();
      } finally {
        this.syncing = false;
        if (hadSuccess) {
          this.retryAttempt = 0;
          this.clearRetryTimer();
        }
        if (hadError && this.queue.some((q) => q.status === 'error' || q.status === 'pending')) {
          this.retryAttempt += 1;
          this.scheduleRetry();
        }
      }
    },
    async retryErroredItems() {
      for (const item of this.queue) {
        if (item.status === 'error') {
          item.status = 'pending';
          item.lastError = undefined;
          item.updatedAt = new Date().toISOString();
        }
      }
      await this.persist();
      await this.processQueue();
    },
    attachOnlineListener() {
      window.addEventListener('offline', () => {
        this.connectivity = 'offline';
      });
      window.addEventListener('online', () => {
        void this.updateConnectivity();
        this.retryAttempt = 0;
        void this.processQueue();
      });
    },
    attachLifecycleListeners() {
      const trigger = () => {
        void this.processQueue();
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') trigger();
      });
      window.addEventListener('focus', trigger);
      window.addEventListener('pageshow', trigger);
    },
    attachPeriodicSync(intervalMs = 45000) {
      if (this.periodicSyncTimerId != null) {
        window.clearInterval(this.periodicSyncTimerId);
      }
      this.periodicSyncTimerId = window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        // Intentamos siempre; processQueue decide según `updateConnectivity`.
        void this.processQueue();
      }, intervalMs);
    }
  }
});

