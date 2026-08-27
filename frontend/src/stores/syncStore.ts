import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';
import { useAuthStore } from './authStore';
import {
  isGoogleDriveAccessError,
  isGoogleDriveAccessTokenExpiredError,
  isSessionExpiredError,
  isSupabaseGatewayUnauthorized,
  SESSION_EXPIRED_SHORT
} from '../utils/supabaseAuthErrors';
import { uploadSensitiveEvidence } from '../services/evidenceStorage';
import { validateRegistroPayload } from '../utils/registroValidation';
import {
  computeOfflinePackageIntegrityHash,
  OFFLINE_INTEGRITY_VERSION,
  verifyOfflinePackageIntegrity
} from '../utils/offlinePackageIntegrity';
import {
  clearOfflineCryptoKey,
  decryptOfflinePayload,
  encryptOfflinePayload
} from '../utils/offlineQueueCrypto';

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
  /** SHA-256 del insertPayloadBase al encolar (integridad offline). */
  integrityHash?: string;
  integrityVersion?: number;
}

interface SyncState {
  queue: SyncItem[];
  syncing: boolean;
  history: SyncItem[];
  connectivity: 'online' | 'offline';
  retryAttempt: number;
  retryTimerId: number | null;
  periodicSyncTimerId: number | null;
  /** Usuario al que pertenece la cola local (evita mezclar dispositivos/cuentas). */
  boundUserId: string | null;
}

export interface ProcessQueueResult {
  hadError: boolean;
  lastError?: string;
  /** Cola vacía, sin red a Supabase, o ya se estaba procesando */
  skipped: boolean;
}

const REGISTRO_BD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function registroExpiresAtIso(): string {
  return new Date(Date.now() + REGISTRO_BD_RETENTION_MS).toISOString();
}

const LEGACY_QUEUE_KEY = 'ts_ctpat_sync_queue_v1';
const LEGACY_HISTORY_KEY = 'ts_ctpat_sync_history_v1';
const LEGACY_COMPLETED_PDF_IDS_KEY = 'ts_ctpat_pdf_completed_ids_v1';
const IDB_NAME = 'ts_ctpat_sync_db_v1';
const IDB_STORE = 'kv';

const MAX_COMPLETED_PDF_IDS = 400;

function userStorageKeys(userId: string) {
  return {
    queue: `ts_ctpat_sync_queue_v2_${userId}`,
    history: `ts_ctpat_sync_history_v2_${userId}`,
    completedPdfs: `ts_ctpat_pdf_completed_v2_${userId}`
  };
}

function readCompletedPdfIds(userId: string | null): Set<string> {
  if (!userId) return new Set();
  const key = userStorageKeys(userId).completedPdfs;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string' && x.length > 0));
  } catch {
    return new Set();
  }
}

function rememberCompletedPdfId(userId: string | null, registroId: string): void {
  const id = registroId.trim();
  if (!id || !userId) return;
  const key = userStorageKeys(userId).completedPdfs;
  const set = readCompletedPdfIds(userId);
  set.add(id);
  const list = [...set];
  const trimmed = list.length > MAX_COMPLETED_PDF_IDS ? list.slice(-MAX_COMPLETED_PDF_IDS) : list;
  try {
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    /* ignore quota */
  }
}

function wasPdfCompletedLocally(userId: string | null, registroId: string): boolean {
  return readCompletedPdfIds(userId).has(registroId.trim());
}

function registroLooksSyncedOnServer(row: {
  sync_status?: string | null;
  drive_file_id?: string | null;
  pdf_storage_path?: string | null;
} | null): boolean {
  if (!row) return false;
  if (row.drive_file_id || row.pdf_storage_path) return true;
  const s = (row.sync_status ?? '').toString().trim().toLowerCase();
  return s === 'synced';
}

/** IndexedDB no puede clonar Proxies (estado reactivo de Pinia/Vue). */
function cloneForIndexedDb<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** JWT para Edge Functions. `force: true` solo en reintentos 401: un refresh forzado suele borrar `provider_token` de Google y rompe la cola con varios PDFs seguidos. */
async function getSupabaseJwtForEdgeFunction(
  auth: ReturnType<typeof useAuthStore>,
  options?: { force?: boolean }
): Promise<string> {
  await auth.refreshSessionForApi({ force: options?.force ?? false });
  const { data: s1, error: e1 } = await supabase.auth.getSession();
  if (e1) throw new Error(`Sesión: ${e1.message}`);
  let token = s1.session?.access_token?.trim();
  if (!token) {
    await new Promise((r) => setTimeout(r, 120));
    const { data: s2 } = await supabase.auth.getSession();
    token = s2.session?.access_token?.trim();
  }
  if (!token) {
    throw new Error('No hay sesión para generar el PDF. Vuelve a iniciar sesión.');
  }
  return token;
}

/**
 * Edge Function `generate-ctpat-pdf`: JWT Supabase + token OAuth de Google Drive.
 * Importante: leer `provider_token` con `getSession()` ANTES de forzar refresh del JWT de Supabase;
 * si no, GoTrue a menudo devuelve sesión sin `provider_token` y Drive falla.
 * Reintenta solo ante 401 de puerta (JWT Supabase).
 */
/** Mensaje cuando Drive falla por token de Google caducado o permisos (texto estable para UI/cola). */
export const GOOGLE_DRIVE_SYNC_USER_MESSAGE =
  'Error al subir a Google Drive. Si llevas la sesión abierta mucho tiempo, cierra sesión e inicia otra vez con Google; si sigue igual, revisa permisos de Drive en tu cuenta.';

async function invokeGenerateCtpatPdf(registroId: string): Promise<void> {
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  const auth = useAuthStore();

  const readGoogleAccessToken = async (): Promise<string | null> => {
    const {
      data: { session: oauthSession }
    } = await supabase.auth.getSession();
    return oauthSession?.provider_token?.trim() || null;
  };

  let googleAccessToken = await readGoogleAccessToken();

  let jwt = await getSupabaseJwtForEdgeFunction(auth, { force: false });

  const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('Falta VITE_SUPABASE_URL.');
  }
  if (!anonKey) {
    throw new Error('Falta VITE_SUPABASE_ANON_KEY en el entorno de la app.');
  }

  const runOnce = async (userJwt: string, googleToken: string | null): Promise<void> => {
    const trimmedJwt = userJwt.trim();
    if (!trimmedJwt) {
      throw new Error('No hay token de sesión para llamar a la función.');
    }

    const url = `${baseUrl}/functions/v1/generate-ctpat-pdf`;
    const payload: Record<string, string> = { registroId };
    // Preferir refresh en servidor; accessToken es fallback de transición.
    if (googleToken) payload.accessToken = googleToken;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedJwt}`,
        apikey: anonKey,
        'X-Client-Info': 'ts-ctpat-pwa'
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { message?: string; error?: string; code?: number };
        const inner = j?.error ?? j?.message ?? text;
        detail = `HTTP ${res.status}: ${inner}`;
      } catch {
        detail = text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`;
      }
      throw new Error(detail);
    }
    if (!text.trim()) return;

    let parsed: { ok?: boolean; error?: string };
    try {
      parsed = JSON.parse(text) as { ok?: boolean; error?: string };
    } catch {
      return;
    }
    if (parsed.ok === false) {
      throw new Error(parsed.error ?? 'Error en función');
    }
  };

  let retriedGoogleToken = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await runOnce(jwt, googleAccessToken);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isSupabaseGatewayUnauthorized(message) && attempt < 4) {
        jwt = await getSupabaseJwtForEdgeFunction(auth, { force: true });
        continue;
      }
      if (!retriedGoogleToken && isGoogleDriveAccessTokenExpiredError(message)) {
        retriedGoogleToken = true;
        await auth.refreshSessionForApi({ force: true });
        googleAccessToken = await readGoogleAccessToken();
        jwt = await getSupabaseJwtForEdgeFunction(auth, { force: true });
        continue;
      }
      throw err;
    }
  }
  throw new Error('generate-ctpat-pdf: reintentos agotados');
}

function shouldInvalidateLocalSession(message: string): boolean {
  // Mantener sesión local salvo errores reales de autenticación Supabase.
  // Errores de Google Drive no deben cerrar sesión Supabase.
  if (isSessionExpiredError(message)) return true;
  const m = message.toLowerCase();
  return (
    (m.includes('jwt') && m.includes('refresh')) ||
    m.includes('invalid refresh token')
  );
}

/** Fallos típicos de transporte (WiFi inestable, reconexión, proxy) — reintentar, no dar por perdido el ítem. */
function isTransientNetworkFailure(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('failed to fetch')) return true;
  if (m.includes('networkerror')) return true;
  if (m.includes('network request failed')) return true;
  if (m.includes('load failed')) return true;
  if (m.includes('fetch')) {
    if (m.includes('aborted') || m.includes('abort')) return true;
    if (m.includes('timeout') || m.includes('timed out')) return true;
  }
  if (m.includes('econnrefused') || m.includes('econnreset') || m.includes('etimedout')) return true;
  if (m.includes('err_connection') || m.includes('err_network') || m.includes('err_internet')) return true;
  if (m.includes('net::err')) return true;
  if (m.includes('socket') && m.includes('hang')) return true;
  if (m.includes('temporarily unavailable')) return true;
  if (m.includes('http 502') || m.includes('http 503') || m.includes('http 504')) return true;
  if (m.includes('service unavailable') && m.includes('503')) return true;
  if (m.includes('bad gateway') && m.includes('502')) return true;
  if (m.includes('gateway timeout') && m.includes('504')) return true;
  return false;
}

let reconnectBurstTimerIds: number[] = [];
let syncConnectivityListenersAttached = false;

function clearReconnectBurstTimers(): void {
  for (const id of reconnectBurstTimerIds) {
    window.clearTimeout(id);
  }
  reconnectBurstTimerIds = [];
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
  return parsed
    .map((it: any) => {
      if (it?.kind === 'sync_drive') return null;
      if (it?.kind) return it as SyncItem;
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
    .filter((x): x is SyncItem => x != null);
}

/** Evita duplicar el mismo guardado offline por doble envío con los mismos datos clave del registro. */
function offlineCreateFingerprint(insertPayloadBase: Record<string, unknown>): string {
  try {
    const tracto = insertPayloadBase.checklist_tracto as Record<string, unknown> | undefined;
    const dg = tracto?.datos_generales as Record<string, unknown> | undefined;
    return JSON.stringify({
      fecha: dg?.fecha,
      tracto: dg?.numeroTracto,
      entradaSalida: dg?.entradaSalida,
      operador: insertPayloadBase.operador,
      caja: dg?.numeroCaja,
      placasTracto: dg?.placasTracto,
      placasCaja: dg?.placasCaja
    });
  } catch {
    return `fallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    queue: [],
    syncing: false,
    history: [],
    connectivity: navigator.onLine ? 'online' : 'offline',
    retryAttempt: 0,
    retryTimerId: null,
    periodicSyncTimerId: null,
    boundUserId: null
  }),
  actions: {
    resetForSignOut() {
      if (this.boundUserId) clearOfflineCryptoKey(this.boundUserId);
      this.boundUserId = null;
      this.queue = [];
      this.history = [];
      this.clearRetryTimer();
      this.retryAttempt = 0;
    },
    async bindUser(userId: string | null) {
      if (!userId) {
        this.resetForSignOut();
        return;
      }
      const changed = this.boundUserId !== userId;
      this.boundUserId = userId;
      if (changed) {
        await this.loadFromStorageForUser(userId);
      }
      await this.reconcileQueueWithServer(userId);
    },
    async reconcileQueueWithServer(userId: string) {
      const STALE_PDF_JOB_MS = 6 * 60 * 60 * 1000;
      const nowMs = Date.now();
      this.queue = this.queue.filter((q) => {
        if (q.kind === 'create_registro_and_generate') {
          return (q.payload as CreateRegistroAndGeneratePayload).userId === userId;
        }
        if (q.kind === 'generate_pdf') {
          const age = nowMs - new Date(q.updatedAt).getTime();
          if (Number.isFinite(age) && age > STALE_PDF_JOB_MS && q.status !== 'processing') {
            return false;
          }
        }
        return true;
      });

      const createPending = this.queue.filter(
        (q) =>
          q.kind === 'create_registro_and_generate' &&
          (q.status === 'pending' || q.status === 'processing' || q.status === 'error')
      );
      const pdfPending = this.queue.filter(
        (q) =>
          q.kind === 'generate_pdf' &&
          (q.status === 'pending' || q.status === 'processing' || q.status === 'error')
      );

      if (createPending.length === 0 && pdfPending.length === 0) {
        await this.persist();
        return;
      }
      if (!navigator.onLine) {
        await this.persist();
        return;
      }

      for (const item of pdfPending) {
        const rid = ((item.payload as GeneratePdfPayload).registroId ?? '').toString().trim();
        if (!rid) continue;
        const { data: existingPdf } = await supabase
          .from('registros_ctpat')
          .select('sync_status, drive_file_id, pdf_storage_path, created_at')
          .eq('id', rid)
          .maybeSingle();
        if (registroLooksSyncedOnServer(existingPdf)) {
          item.status = 'done';
          rememberCompletedPdfId(userId, rid);
          item.lastError = undefined;
          item.updatedAt = new Date().toISOString();
          continue;
        }
        const created = existingPdf?.created_at ? new Date(String(existingPdf.created_at)).getTime() : NaN;
        if (Number.isFinite(created) && Date.now() - created > STALE_PDF_JOB_MS) {
          item.status = 'done';
          rememberCompletedPdfId(userId, rid);
          item.lastError = undefined;
          item.updatedAt = new Date().toISOString();
        }
      }

      const now = new Date().toISOString();
      for (const item of createPending) {
        const base = (item.payload as CreateRegistroAndGeneratePayload).insertPayloadBase;
        const crid = base?.client_request_id as string | undefined;
        if (!crid) continue;

        const { data: existing } = await supabase
          .from('registros_ctpat')
          .select('id, folio_pdf, sync_status, drive_file_id, pdf_storage_path')
          .eq('user_id', userId)
          .eq('client_request_id', crid)
          .maybeSingle();

        if (!existing?.id) continue;

        const rid = existing.id as string;
        if (registroLooksSyncedOnServer(existing)) {
          item.status = 'done';
          rememberCompletedPdfId(userId, rid);
        } else {
          item.kind = 'generate_pdf';
          item.id = `pdf_${rid}`;
          item.payload = {
            registroId: rid,
            folio: (existing.folio_pdf as string | null) ?? undefined
          } satisfies GeneratePdfPayload;
          item.status = 'pending';
        }
        item.lastError = undefined;
        item.updatedAt = now;
      }
      this.queue = this.queue.filter(
        (q) => q.status === 'pending' || q.status === 'error' || q.status === 'processing'
      );
      await this.persist();
    },
    async loadFromStorageForUser(userId: string) {
      const keys = userStorageKeys(userId);
      const parseStored = async (raw: unknown): Promise<SyncItem[] | null> => {
        if (raw == null) return null;
        if (typeof raw === 'string') {
          try {
            const plain = raw.startsWith('enc1.')
              ? await decryptOfflinePayload(userId, raw)
              : raw;
            return normalizeQueueItems(JSON.parse(plain));
          } catch {
            return null;
          }
        }
        if (Array.isArray(raw)) return normalizeQueueItems(raw as SyncItem[]);
        return null;
      };
      try {
        let queueFromDb = await parseStored(await idbGet<unknown>(keys.queue));
        let historyFromDb = await parseStored(await idbGet<unknown>(keys.history));

        if (!queueFromDb) {
          const legacy = localStorage.getItem(LEGACY_QUEUE_KEY);
          if (legacy) {
            queueFromDb = normalizeQueueItems(JSON.parse(legacy));
            await idbSet(keys.queue, cloneForIndexedDb(queueFromDb));
            localStorage.removeItem(LEGACY_QUEUE_KEY);
          }
        }
        if (!historyFromDb) {
          const legacyH = localStorage.getItem(LEGACY_HISTORY_KEY);
          if (legacyH) {
            historyFromDb = JSON.parse(legacyH) as SyncItem[];
            await idbSet(keys.history, cloneForIndexedDb(historyFromDb));
            localStorage.removeItem(LEGACY_HISTORY_KEY);
          }
        }

        if (!queueFromDb) {
          const raw = localStorage.getItem(keys.queue);
          if (raw) queueFromDb = await parseStored(raw);
        }
        if (!historyFromDb) {
          const rawH = localStorage.getItem(keys.history);
          if (rawH) historyFromDb = await parseStored(rawH);
        }

        this.queue = queueFromDb ?? [];
        this.history = historyFromDb && Array.isArray(historyFromDb) ? historyFromDb : [];

        const legacyCompleted = localStorage.getItem(LEGACY_COMPLETED_PDF_IDS_KEY);
        if (legacyCompleted && !localStorage.getItem(keys.completedPdfs)) {
          localStorage.setItem(keys.completedPdfs, legacyCompleted);
          localStorage.removeItem(LEGACY_COMPLETED_PDF_IDS_KEY);
        }

        if (this.rescueStuckProcessingItems()) {
          await this.persist();
        }
      } catch (e) {
        console.warn('SyncStore: IndexedDB no disponible, usando localStorage', e);
        const raw = localStorage.getItem(keys.queue);
        const rawHistory = localStorage.getItem(keys.history);
        try {
          this.queue = raw
            ? ((await (async () => {
                const plain = raw.startsWith('enc1.')
                  ? await decryptOfflinePayload(userId, raw)
                  : raw;
                return normalizeQueueItems(JSON.parse(plain));
              })()) as SyncItem[])
            : [];
          this.history = rawHistory
            ? ((await (async () => {
                const plain = rawHistory.startsWith('enc1.')
                  ? await decryptOfflinePayload(userId, rawHistory)
                  : rawHistory;
                return JSON.parse(plain) as SyncItem[];
              })()) as SyncItem[])
            : [];
        } catch {
          this.queue = [];
          this.history = [];
        }
        if (this.rescueStuckProcessingItems()) {
          await this.persist();
        }
      }
    },
    clearRetryTimer() {
      if (this.retryTimerId != null) {
        window.clearTimeout(this.retryTimerId);
        this.retryTimerId = null;
      }
    },
    scheduleRetry() {
      this.clearRetryTimer();
      const ms = Math.min(60000, 5000 * 2 ** Math.max(0, this.retryAttempt - 1));
      this.retryTimerId = window.setTimeout(() => {
        void this.processQueue();
      }, ms);
    },
    /**
     * Estado de red para la UI y la cola.
     * - Si el navegador reporta offline → offline.
     * - Si reporta online, intentamos un ping liviano a Supabase; si falla (proxy, firewall,
     *   timeout, respuesta no 2xx) NO forzamos “sin conexión”: muchas redes bloquean /auth/v1/health
     *   pero el resto (REST, Edge) sí funciona.
     */
    async updateConnectivity(maxAttempts = 1) {
      if (!navigator.onLine) {
        this.connectivity = 'offline';
        return;
      }

      const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
      if (!base) {
        this.connectivity = 'online';
        return;
      }

      const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
      const attempts = Math.max(1, Math.min(5, maxAttempts));

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 400 + attempt * 200));
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6500);
        try {
          const res = await fetch(`${base}/auth/v1/health`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
            headers: anon ? { apikey: anon } : {}
          });
          if (res.ok) {
            this.connectivity = 'online';
            return;
          }
        } catch {
          /* timeout, DNS, CORS raro, etc. */
        } finally {
          window.clearTimeout(timer);
        }
      }

      this.connectivity = 'online';
    },
    async loadFromStorage() {
      if (this.boundUserId) {
        await this.loadFromStorageForUser(this.boundUserId);
      }
    },
    async persist() {
      if (!this.boundUserId) return;
      const keys = userStorageKeys(this.boundUserId);
      const queuePlain = JSON.stringify(this.queue);
      const historyPlain = JSON.stringify(this.history);
      let queueStore: unknown = cloneForIndexedDb(this.queue);
      let historyStore: unknown = cloneForIndexedDb(this.history);
      let queueLs = queuePlain;
      let historyLs = historyPlain;
      try {
        queueLs = await encryptOfflinePayload(this.boundUserId, queuePlain);
        historyLs = await encryptOfflinePayload(this.boundUserId, historyPlain);
        queueStore = queueLs;
        historyStore = historyLs;
      } catch (e) {
        console.warn('SyncStore: no se pudo cifrar cola offline', e);
      }
      try {
        await Promise.all([idbSet(keys.queue, queueStore), idbSet(keys.history, historyStore)]);
      } catch (e) {
        console.warn('SyncStore: error guardando en IndexedDB, usando localStorage', e);
      }
      localStorage.setItem(keys.queue, queueLs);
      localStorage.setItem(keys.history, historyLs);
    },
    /**
     * JWT inválido (p. ej. usuario borrado en Supabase, refresh revocado): limpia cola local y cierra sesión.
     */
    /** Cierra sesión sin toast (el caller muestra un solo mensaje claro). */
    async handleSessionInvalidated() {
      this.clearRetryTimer();
      this.retryAttempt = 0;
      this.queue = [];
      await this.persist();
      const auth = useAuthStore();
      await auth.signOut();
    },
    /** Recupera ítems que quedaron en "processing" (cierre de pestaña o error abrupto). */
    rescueStuckProcessingItems(): boolean {
      let touched = false;
      const now = new Date().toISOString();
      for (const item of this.queue) {
        if (item.status === 'processing') {
          item.status = 'pending';
          item.updatedAt = now;
          touched = true;
        }
      }
      return touched;
    },
    async enqueueCreateRegistroAndGenerate(payload: CreateRegistroAndGeneratePayload) {
      const clientRequestId = crypto.randomUUID();
      const insertPayloadBase = validateRegistroPayload({
        ...(payload.insertPayloadBase as Record<string, unknown>),
        client_request_id: clientRequestId
      });
      const safePayload = {
        ...payload,
        insertPayloadBase
      };
      const integrityHash = await computeOfflinePackageIntegrityHash(
        safePayload.insertPayloadBase as Record<string, unknown>
      );
      const now = new Date().toISOString();
      const fp = offlineCreateFingerprint(safePayload.insertPayloadBase as Record<string, unknown>);
      const dup = this.queue.find(
        (q) =>
          q.kind === 'create_registro_and_generate' &&
          q.status === 'pending' &&
          offlineCreateFingerprint(
            (q.payload as CreateRegistroAndGeneratePayload).insertPayloadBase as Record<string, unknown>
          ) === fp
      );
      if (dup) {
        dup.payload = safePayload;
        dup.integrityHash = integrityHash;
        dup.integrityVersion = OFFLINE_INTEGRITY_VERSION;
        dup.lastError = undefined;
        dup.updatedAt = now;
        await this.persist();
        return;
      }
      const id = `create_${payload.userId}_${Date.now()}`;
      const item: SyncItem = {
        id,
        kind: 'create_registro_and_generate',
        payload: safePayload,
        status: 'pending',
        updatedAt: now,
        integrityHash,
        integrityVersion: OFFLINE_INTEGRITY_VERSION
      };
      this.queue.push(item);
      await this.persist();
    },
    async enqueueGeneratePdf(payload: GeneratePdfPayload) {
      const registroId = (payload.registroId ?? '').toString().trim();
      if (!registroId) return;

      const uid = this.boundUserId;

      if (wasPdfCompletedLocally(uid, registroId)) {
        return;
      }

      if (navigator.onLine) {
        const { data: existingReg } = await supabase
          .from('registros_ctpat')
          .select('sync_status, drive_file_id, pdf_storage_path, created_at')
          .eq('id', registroId)
          .maybeSingle();
        if (registroLooksSyncedOnServer(existingReg)) {
          rememberCompletedPdfId(uid, registroId);
          return;
        }
        const createdAtMs = existingReg?.created_at
          ? new Date(String(existingReg.created_at)).getTime()
          : NaN;
        if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > 6 * 60 * 60 * 1000) {
          rememberCompletedPdfId(uid, registroId);
          return;
        }
      }

      const now = new Date().toISOString();
      const id = `pdf_${registroId}`;
      const alreadyQueued = this.queue.some((q) => {
        if (q.id === id && q.status !== 'done') return true;
        if (q.kind !== 'generate_pdf') return false;
        const rid = ((q.payload as GeneratePdfPayload).registroId ?? '').toString().trim();
        return rid === registroId && (q.status === 'pending' || q.status === 'processing' || q.status === 'error');
      });
      if (alreadyQueued) {
        return;
      }

      const doneBefore = this.history.some((h) => {
        if (h.status !== 'done') return false;
        if (h.id === id) return true;
        if (h.kind !== 'generate_pdf') return false;
        const rid = ((h.payload as GeneratePdfPayload).registroId ?? '').toString().trim();
        return rid === registroId;
      });
      if (doneBefore) {
        rememberCompletedPdfId(uid, registroId);
        return;
      }

      const item: SyncItem = {
        id,
        kind: 'generate_pdf',
        payload: { ...payload, registroId },
        status: 'pending',
        updatedAt: now
      };
      this.queue.push(item);
      await this.persist();
    },
    async processQueue(): Promise<ProcessQueueResult> {
      if (this.syncing) {
        return { hadError: false, skipped: true };
      }
      if (this.queue.length === 0) {
        return { hadError: false, skipped: true };
      }

      this.syncing = true;
      let hadSuccess = false;
      let hadError = false;
      let lastError: string | undefined;

      try {
        const authStore = useAuthStore();

        if (this.rescueStuckProcessingItems()) {
          await this.persist();
        }

        await this.updateConnectivity(navigator.onLine ? 2 : 1);
        if (this.connectivity !== 'online') {
          return { hadError: false, skipped: true };
        }

        // Leer sesión sin renovar JWT salvo que falte access_token: renovar aquí suele borrar
        // `provider_token` de Google antes de que la cola llame a `invokeGenerateCtpatPdf`.
        const {
          data: { session: sessionFromStorage }
        } = await supabase.auth.getSession();
        let session = sessionFromStorage;
        if (!session?.access_token) {
          session =
            (await authStore.refreshSessionForApi({ force: true })) ??
            (await supabase.auth.getSession()).data.session ??
            null;
        }
        if (!session?.access_token) {
          return {
            hadError: true,
            lastError:
              'No se pudo validar la sesión para sincronizar. Comprueba la conexión o vuelve a iniciar sesión.',
            skipped: false
          };
        }

        for (const item of this.queue) {
          if (item.status !== 'pending') continue;
          item.status = 'processing';
          item.updatedAt = new Date().toISOString();
          await this.persist();

          try {
            if (item.kind === 'generate_pdf') {
              const payload = item.payload as GeneratePdfPayload;
              const rid = (payload.registroId ?? '').toString().trim();
              if (!rid) {
                throw new Error('Cola de sincronización: falta el id del registro para generar el PDF.');
              }

              // Idempotencia: si BD ya lo marca sincronizado, no regenerar PDF.
              const { data: existingReg } = await supabase
                .from('registros_ctpat')
                .select('sync_status, drive_file_id, pdf_storage_path, created_at')
                .eq('id', rid)
                .maybeSingle();

              const status = (existingReg?.sync_status ?? '').toString().trim().toLowerCase();
              const createdAtMs = existingReg?.created_at
                ? new Date(String(existingReg.created_at)).getTime()
                : NaN;
              const isOldRegistro =
                Number.isFinite(createdAtMs) && Date.now() - createdAtMs > 6 * 60 * 60 * 1000;
              const alreadySynced =
                status === 'synced' ||
                Boolean(existingReg?.drive_file_id) ||
                Boolean(existingReg?.pdf_storage_path) ||
                isOldRegistro ||
                wasPdfCompletedLocally(this.boundUserId, rid);

              if (alreadySynced) {
                rememberCompletedPdfId(this.boundUserId, rid);
                item.status = 'done';
                item.lastError = undefined;
                item.updatedAt = new Date().toISOString();
                this.history.unshift({ ...item });
                hadSuccess = true;
                continue;
              }

              await invokeGenerateCtpatPdf(rid);

              rememberCompletedPdfId(this.boundUserId, rid);
              item.status = 'done';
              item.lastError = undefined;
              item.updatedAt = new Date().toISOString();
              this.history.unshift({ ...item });
              hadSuccess = true;
            } else if (item.kind === 'create_registro_and_generate') {
              const payload = item.payload as CreateRegistroAndGeneratePayload;

              if (item.integrityHash) {
                const payloadForHash = validateRegistroPayload(payload.insertPayloadBase);
                const ok = await verifyOfflinePackageIntegrity(
                  payloadForHash as Record<string, unknown>,
                  item.integrityHash
                );
                if (!ok) {
                  throw new Error(
                    'Integridad del paquete offline comprometida (SHA-256). Revisa la cola o vuelve a capturar el registro.'
                  );
                }
              }

              const organizationId =
                (session?.user?.app_metadata?.org_id as string | undefined)?.trim() ||
                payload.userId;

              let safeInsertPayloadBase = validateRegistroPayload(payload.insertPayloadBase);
              const images = Array.isArray(safeInsertPayloadBase.image_urls)
                ? safeInsertPayloadBase.image_urls
                : [];
              const hasSensitiveInlineData =
                images.some((v) => typeof v === 'string' && v.startsWith('data:')) ||
                (typeof safeInsertPayloadBase.firma_operador === 'string' &&
                  safeInsertPayloadBase.firma_operador.startsWith('data:')) ||
                (typeof safeInsertPayloadBase.firma_oficial === 'string' &&
                  safeInsertPayloadBase.firma_oficial.startsWith('data:'));

              if (hasSensitiveInlineData) {
                const uploaded = await uploadSensitiveEvidence({
                  userId: payload.userId,
                  organizationId,
                  payloadId: item.id,
                  imageDataUrls: images.filter((v) => typeof v === 'string'),
                  signatureOperadorDataUrl:
                    typeof safeInsertPayloadBase.firma_operador === 'string'
                      ? safeInsertPayloadBase.firma_operador
                      : undefined,
                  signatureOficialDataUrl:
                    typeof safeInsertPayloadBase.firma_oficial === 'string'
                      ? safeInsertPayloadBase.firma_oficial
                      : undefined
                });
                safeInsertPayloadBase = validateRegistroPayload({
                  ...safeInsertPayloadBase,
                  organization_id: organizationId,
                  image_urls: uploaded.imagePaths,
                  firma_operador: uploaded.signatureOperadorPath,
                  firma_oficial: uploaded.signatureOficialPath
                });
              }

              const crid = safeInsertPayloadBase.client_request_id as string | undefined;
              if (crid) {
                const { data: existingByClient } = await supabase
                  .from('registros_ctpat')
                  .select('id, folio_pdf, sync_status, drive_file_id, pdf_storage_path')
                  .eq('user_id', payload.userId)
                  .eq('client_request_id', crid)
                  .maybeSingle();
                if (existingByClient?.id) {
                  const registroId = existingByClient.id as string;
                  if (registroLooksSyncedOnServer(existingByClient)) {
                    rememberCompletedPdfId(this.boundUserId, registroId);
                    item.status = 'done';
                    item.lastError = undefined;
                    item.updatedAt = new Date().toISOString();
                    this.history.unshift({ ...item });
                    hadSuccess = true;
                    continue;
                  }
                  item.kind = 'generate_pdf';
                  item.id = `pdf_${registroId}`;
                  item.payload = {
                    registroId,
                    folio: (existingByClient.folio_pdf as string | null) ?? undefined
                  } satisfies GeneratePdfPayload;
                  item.updatedAt = new Date().toISOString();
                  await this.persist();
                  await invokeGenerateCtpatPdf(registroId);
                  rememberCompletedPdfId(this.boundUserId, registroId);
                  item.status = 'done';
                  item.lastError = undefined;
                  item.updatedAt = new Date().toISOString();
                  this.history.unshift({ ...item });
                  hadSuccess = true;
                  continue;
                }
              }

              const { data: folioData, error: folioErr } = await supabase.rpc('next_folio_ctpat', {
                p_user_id: payload.userId
              });

              if (folioErr) {
                if (isSessionExpiredError(folioErr.message, folioErr.code)) {
                  await this.handleSessionInvalidated();
                  return { hadError: true, lastError: SESSION_EXPIRED_SHORT, skipped: false };
                }
              }
              if (folioErr || !folioData) {
                throw new Error(`No se pudo generar folio automático: ${folioErr?.message ?? 'sin detalle'}`);
              }

              const folioAuto = folioData as string;

              const insertPayload = {
                ...safeInsertPayloadBase,
                folio_pdf: folioAuto,
                sync_status: 'pending',
                expires_at: registroExpiresAtIso()
              };

              const { data: inserted, error: insertErr } = await supabase
                .from('registros_ctpat')
                .insert(insertPayload)
                .select('id, created_at, folio_pdf')
                .single();

              if (insertErr) {
                if (isSessionExpiredError(insertErr.message, insertErr.code)) {
                  await this.handleSessionInvalidated();
                  return { hadError: true, lastError: SESSION_EXPIRED_SHORT, skipped: false };
                }
              }
              if (insertErr || !inserted) {
                throw new Error(`Error insertando registro: ${insertErr?.message ?? 'sin detalle'}`);
              }

              const registroId = inserted.id as string;

              // Tras insertar en BD, el ítem pasa a solo «generar PDF»: si el PDF falla y se reintenta,
              // no se vuelve a insertar (evita folios/registros duplicados).
              item.kind = 'generate_pdf';
              item.id = `pdf_${registroId}`;
              item.payload = {
                registroId,
                folio: folioAuto
              } satisfies GeneratePdfPayload;
              item.updatedAt = new Date().toISOString();
              await this.persist();

              await invokeGenerateCtpatPdf(registroId);

              rememberCompletedPdfId(this.boundUserId, registroId);
              item.status = 'done';
              item.lastError = undefined;
              item.updatedAt = new Date().toISOString();
              this.history.unshift({ ...item });
              hadSuccess = true;
            }
          } catch (err) {
            const rawMessage = err instanceof Error ? err.message : String(err);
            // El toast a veces sustituye por mensaje genérico; el detalle real va a consola.
            // eslint-disable-next-line no-console
            console.error('[syncStore] error al guardar / generar PDF (detalle técnico):', rawMessage);
            const message = isGoogleDriveAccessError(rawMessage)
              ? GOOGLE_DRIVE_SYNC_USER_MESSAGE
              : rawMessage;
            if (shouldInvalidateLocalSession(message)) {
              await this.handleSessionInvalidated();
              return { hadError: true, lastError: SESSION_EXPIRED_SHORT, skipped: false };
            }
            if (isTransientNetworkFailure(rawMessage)) {
              item.status = 'pending';
              item.lastError = undefined;
              item.updatedAt = new Date().toISOString();
              hadError = true;
              lastError = message;
              continue;
            }
            item.status = 'error';
            item.lastError = message;
            item.updatedAt = new Date().toISOString();
            this.history.unshift({ ...item });
            hadError = true;
            lastError = message;
          }
        }

        this.queue = this.queue.filter((q) => q.status === 'pending' || q.status === 'error');
        await this.persist();
        return { hadError, lastError, skipped: false };
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
      return this.processQueue();
    },
    async clearErroredItems() {
      const before = this.queue.length;
      this.queue = this.queue.filter((item) => item.status !== 'error');
      if (this.queue.length !== before) {
        await this.persist();
      }
    },
    async markErroredItemsAsPending() {
      let touched = false;
      for (const item of this.queue) {
        if (item.status === 'error') {
          const msg = (item.lastError ?? '').toLowerCase();
          // Errores funcionales (requiere acción del usuario) no se reintentan automáticamente.
          if (msg.includes('template requerida') || msg.includes('plantilla pdf')) {
            continue;
          }
          item.status = 'pending';
          item.lastError = undefined;
          item.updatedAt = new Date().toISOString();
          touched = true;
        }
      }
      if (touched) {
        await this.persist();
      }
    },
    /** Tras reconectar, la red a veces falla los primeros segundos; reintentamos sin depender solo del evento `online`. */
    scheduleReconnectBurst() {
      clearReconnectBurstTimers();
      const delays = [1200, 3500, 7000];
      for (const ms of delays) {
        const id = window.setTimeout(() => {
          void (async () => {
            if (!navigator.onLine) return;
            await this.updateConnectivity(2);
            await this.markErroredItemsAsPending();
            await this.processQueue();
          })();
        }, ms);
        reconnectBurstTimerIds.push(id);
      }
    },
    attachOnlineListener() {
      if (syncConnectivityListenersAttached) return;
      syncConnectivityListenersAttached = true;
      window.addEventListener('offline', () => {
        this.connectivity = 'offline';
        clearReconnectBurstTimers();
      });
      window.addEventListener('online', () => {
        void (async () => {
          await new Promise((r) => setTimeout(r, 350));
          await this.updateConnectivity(3);
          this.retryAttempt = 0;
          await this.markErroredItemsAsPending();
          const auth = useAuthStore();
          if (auth.isSignedIn) {
            await auth.refreshSessionForApi({ force: false });
          }
          await this.processQueue();
          this.scheduleReconnectBurst();
        })();
      });
    },
    attachLifecycleListeners() {
      const trigger = () => {
        const auth = useAuthStore();
        if (auth.isSignedIn) {
          void auth.refreshSessionForApi({ force: false });
        }
        void (async () => {
          if (navigator.onLine) {
            await this.markErroredItemsAsPending();
          }
          await this.updateConnectivity(navigator.onLine ? 2 : 1);
          await this.processQueue();
        })();
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
        void (async () => {
          if (navigator.onLine) {
            await this.markErroredItemsAsPending();
          }
          await this.updateConnectivity(navigator.onLine ? 2 : 1);
          await this.processQueue();
        })();
      }, intervalMs);
    }
  }
});
