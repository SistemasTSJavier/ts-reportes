<template>
  <div class="space-y-6">
    <section class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="text-xl sm:text-2xl font-bold text-slate-800">
          Registros
        </h2>
        <p class="text-sm text-slate-500 mt-0.5">
          Gestiona tus reportes de entrada y salida de transporte.
        </p>
      </div>
      <button
        class="btn-primary w-full sm:w-auto shrink-0"
        @click="goNew"
      >
        Nuevo registro
      </button>
    </section>

    <section class="card p-4 sm:p-5">
      <div class="flex flex-wrap items-center gap-3">
        <span class="text-sm font-medium text-slate-700">Filtrar por movimiento</span>
        <span
          class="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
          :class="syncStatusClass"
        >
          {{ syncStatusText }}
        </span>
        <button
          v-if="erroredSyncCount > 0"
          type="button"
          class="text-xs text-tactical-blue font-semibold hover:underline"
          @click="retrySyncErrors"
        >
          Reintentar sincronización ({{ erroredSyncCount }})
        </button>
        <button
          v-if="pwa.isInstallable && !pwa.isStandalone"
          type="button"
          class="text-xs text-emerald-700 font-semibold hover:underline"
          @click="installPwa"
        >
          Instalar app en Android
        </button>
        <button
          v-if="syncQueueItems.length > 0"
          type="button"
          class="text-xs text-indigo-700 font-semibold hover:underline disabled:opacity-60"
          :disabled="syncStore.syncing || syncStore.connectivity === 'offline'"
          @click="syncNow"
        >
          {{ syncStore.syncing ? 'Sincronizando...' : 'Sincronizar ahora' }}
        </button>
        <div class="inline-flex rounded-lg border border-slate-200 bg-slate-50/50 p-0.5">
          <button
            v-for="opt in movementOptions"
            :key="opt.value"
            type="button"
            class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
            :class="
              movementFilter === opt.value
                ? 'bg-tactical-blue text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-800 hover:bg-white'
            "
            @click="movementFilter = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </section>

    <section class="card p-4 sm:p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h3 class="text-base font-semibold text-slate-800">Cola offline</h3>
        <div class="flex items-center gap-3">
          <span class="text-xs text-slate-500">Total: {{ syncQueueItems.length }}</span>
          <button
            v-if="erroredSyncCount > 0"
            type="button"
            class="text-xs text-rose-700 font-semibold hover:underline"
            @click="clearSyncErrors"
          >
            Limpiar errores
          </button>
        </div>
      </div>

      <div class="mb-3 inline-flex rounded-lg border border-slate-200 bg-slate-50/50 p-0.5">
        <button
          v-for="opt in queueFilterOptions"
          :key="opt.value"
          type="button"
          class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors"
          :class="
            queueFilter === opt.value
              ? 'bg-tactical-blue text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-800 hover:bg-white'
          "
          @click="queueFilter = opt.value"
        >
          {{ opt.label }} ({{ queueFilterCount(opt.value) }})
        </button>
      </div>

      <div v-if="filteredSyncQueueItems.length === 0" class="text-sm text-slate-500">
        No hay elementos en cola.
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="item in filteredSyncQueueItems"
          :key="item.id"
          class="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-slate-800 truncate">
                {{ syncItemTitle(item) }}
              </p>
              <p class="text-xs text-slate-500 mt-1">
                Actualizado: {{ formatSyncDate(item.updatedAt) }}
              </p>
              <p v-if="item.lastError" class="text-xs text-rose-700 mt-1 break-words">
                Error: {{ item.lastError }}
              </p>
            </div>
            <span
              class="shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
              :class="syncItemBadgeClass(item.status)"
            >
              {{ syncItemStatusText(item.status) }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Lista de registros por folio -->
    <section class="card p-4 sm:p-5">
      <div class="flex items-center justify-between gap-3 mb-4">
        <h3 class="text-base font-semibold text-slate-800">Registros guardados</h3>
        <button
          type="button"
          class="text-sm text-tactical-blue font-medium hover:underline"
          :disabled="loadingRegistros"
          @click="loadRegistros"
        >
          {{ loadingRegistros ? 'Cargando…' : 'Actualizar' }}
        </button>
      </div>
      <div
        v-if="loadingRegistros && registros.length === 0"
        class="text-center py-8 text-slate-500 text-sm"
      >
        Cargando registros…
      </div>
      <div
        v-else-if="filteredRegistros.length === 0"
        class="text-center py-8 text-slate-500 text-sm"
      >
        <p>{{ movementFilter === 'all' ? 'Aún no hay registros.' : 'No hay registros con este filtro.' }}</p>
        <p class="text-xs mt-1">Crea uno con «Nuevo registro».</p>
      </div>
      <ul v-else class="divide-y divide-slate-100 -mx-1 px-1">
        <li
          v-for="r in filteredRegistros"
          :key="r.id"
          class="py-3 flex items-center justify-between gap-3"
        >
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-slate-800">
              {{ formatFolio(r.folio_pdf) || 'Sin folio' }}
            </p>
            <p class="text-xs text-slate-500 mt-0.5">
              {{ new Date(r.created_at).toLocaleString() }}
            </p>
          </div>
          <span
            class="shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
            :class="movementBadgeClass(r)"
          >
            {{ movementLabel(r) }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { supabase } from '../supabaseClient';
import { useAuthStore } from '../stores/authStore';
import { usePwaStore } from '../stores/pwaStore';
import { useSyncStore, type SyncKind } from '../stores/syncStore';
import { useToastStore } from '../stores/toastStore';

const router = useRouter();
const authStore = useAuthStore();
const syncStore = useSyncStore();
const pwa = usePwaStore();
const toastStore = useToastStore();
const queueFilter = ref<'all' | 'pending' | 'error'>('all');

const movementFilter = ref<'all' | 'entrada' | 'salida'>('all');
const registros = ref<Array<{
  id: string;
  folio_pdf: string | null;
  created_at: string;
  checklist_tracto: Record<string, unknown> | null;
}>>([]);
const loadingRegistros = ref(false);

const movementOptions = [
  { label: 'Todos', value: 'all' },
  { label: 'Entrada', value: 'entrada' },
  { label: 'Salida', value: 'salida' }
] as const;
const queueFilterOptions = [
  { label: 'Todos', value: 'all' },
  { label: 'Pendientes', value: 'pending' },
  { label: 'Errores', value: 'error' }
] as const;

interface QueueRow {
  id: string;
  kind: SyncKind;
  status: 'pending' | 'processing' | 'done' | 'error';
  lastError?: string;
  updatedAt: string;
}

const pendingSyncCount = computed(
  () => syncStore.queue.filter((q) => q.status === 'pending' || q.status === 'processing').length
);
const erroredSyncCount = computed(() => syncStore.queue.filter((q) => q.status === 'error').length);
const syncQueueItems = computed<QueueRow[]>(() =>
  [...syncStore.queue].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
);
const filteredSyncQueueItems = computed(() => {
  if (queueFilter.value === 'all') return syncQueueItems.value;
  if (queueFilter.value === 'pending') {
    return syncQueueItems.value.filter((q) => q.status === 'pending' || q.status === 'processing');
  }
  return syncQueueItems.value.filter((q) => q.status === 'error');
});
const syncStatusText = computed(() => {
  if (syncStore.connectivity === 'offline') return 'Sin conexión';
  if (pendingSyncCount.value > 0) return `Sincronizando pendientes (${pendingSyncCount.value})`;
  if (erroredSyncCount.value > 0) return `Errores de sincronización (${erroredSyncCount.value})`;
  return 'Sincronización al día';
});
const syncStatusClass = computed(() => {
  if (syncStore.connectivity === 'offline') return 'bg-amber-100 text-amber-800';
  if (erroredSyncCount.value > 0) return 'bg-rose-100 text-rose-800';
  if (pendingSyncCount.value > 0) return 'bg-blue-100 text-blue-800';
  return 'bg-emerald-100 text-emerald-800';
});

function formatFolio(folio: string | null | undefined): string {
  if (!folio || typeof folio !== 'string') return '';
  const m = folio.trim().match(/^TS-0*(\d+)$/i);
  if (m) return `TS-${String(Number(m[1]))}`;
  return folio;
}

function getEntradaSalida(r: { checklist_tracto: Record<string, unknown> | null }): 'Entrada' | 'Salida' | null {
  const dg = (r.checklist_tracto as Record<string, unknown>)?.datos_generales as Record<string, unknown> | undefined;
  const v = dg?.entradaSalida;
  if (v === 'Entrada' || v === 'Salida') return v;
  return null;
}

const filteredRegistros = computed(() => {
  const list = registros.value;
  if (movementFilter.value === 'all') return list;
  const want = movementFilter.value === 'entrada' ? 'Entrada' : 'Salida';
  return list.filter((r) => getEntradaSalida(r) === want);
});

function movementLabel(r: { checklist_tracto: Record<string, unknown> | null }): string {
  const v = getEntradaSalida(r);
  return v === 'Entrada' ? 'Entrada' : v === 'Salida' ? 'Salida' : '—';
}

function movementBadgeClass(r: { checklist_tracto: Record<string, unknown> | null }): string {
  const v = getEntradaSalida(r);
  if (v === 'Entrada') return 'bg-blue-100 text-blue-800';
  if (v === 'Salida') return 'bg-slate-200 text-slate-800';
  return 'bg-slate-100 text-slate-600';
}

async function loadRegistros() {
  loadingRegistros.value = true;
  if (navigator.onLine) {
    await authStore.refreshSessionForApi();
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) {
    registros.value = [];
    loadingRegistros.value = false;
    return;
  }
  const { data, error } = await supabase
    .from('registros_ctpat')
    .select('id, folio_pdf, created_at, checklist_tracto')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error cargando registros', error);
    registros.value = [];
  } else {
    registros.value = data ?? [];
  }
  loadingRegistros.value = false;
}

onMounted(() => {
  loadRegistros();
});

watch(
  () => router.currentRoute.value.name,
  (name) => {
    if (name === 'home') loadRegistros();
  }
);

function goNew() {
  router.push({ name: 'registro-new' });
}

function retrySyncErrors() {
  void syncStore.retryErroredItems();
}

async function installPwa() {
  const outcome = await pwa.promptInstall();
  if (outcome === 'accepted') {
    toastStore.success('App instalada', 'Ya puedes abrirla desde tu pantalla de inicio.');
    return;
  }
  if (outcome === 'dismissed') {
    toastStore.info('Instalación cancelada', 'Puedes intentarlo nuevamente cuando quieras.');
  }
}

function syncNow() {
  void syncStore.processQueue();
}

function clearSyncErrors() {
  syncStore.queue = syncStore.queue.filter((q) => q.status !== 'error');
  void syncStore.persist();
}

function syncItemStatusText(status: QueueRow['status']): string {
  if (status === 'pending') return 'Pendiente';
  if (status === 'processing') return 'Procesando';
  if (status === 'done') return 'Completado';
  return 'Error';
}

function syncItemBadgeClass(status: QueueRow['status']): string {
  if (status === 'pending') return 'bg-amber-100 text-amber-800';
  if (status === 'processing') return 'bg-blue-100 text-blue-800';
  if (status === 'done') return 'bg-emerald-100 text-emerald-800';
  return 'bg-rose-100 text-rose-800';
}

function syncItemTitle(item: QueueRow): string {
  if (item.kind === 'create_registro_and_generate') return 'Crear registro + generar PDF';
  return 'Generar PDF existente';
}

function formatSyncDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function queueFilterCount(filter: 'all' | 'pending' | 'error'): number {
  if (filter === 'all') return syncQueueItems.value.length;
  if (filter === 'pending') {
    return syncQueueItems.value.filter((q) => q.status === 'pending' || q.status === 'processing').length;
  }
  return syncQueueItems.value.filter((q) => q.status === 'error').length;
}
</script>
