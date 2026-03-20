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

const router = useRouter();

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
</script>
