<template>
  <section class="card p-4 sm:p-5 space-y-4">
    <div>
      <h2 class="text-xl font-bold text-slate-800">Configurar plantilla PDF</h2>
      <p class="text-sm text-slate-500 mt-1">
        Define tu formato fijo una sola vez. Esta plantilla se usara para todos tus PDF.
      </p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="space-y-2">
        <label class="text-xs font-semibold text-slate-700">Caja logo (X)</label>
        <input v-model.number="form.logoX" type="number" class="w-full rounded border px-2 py-1" />
      </div>
      <div class="space-y-2">
        <label class="text-xs font-semibold text-slate-700">Caja logo (Y)</label>
        <input v-model.number="form.logoY" type="number" class="w-full rounded border px-2 py-1" />
      </div>
      <div class="space-y-2">
        <label class="text-xs font-semibold text-slate-700">Ancho logo</label>
        <input v-model.number="form.logoW" type="number" class="w-full rounded border px-2 py-1" />
      </div>
      <div class="space-y-2">
        <label class="text-xs font-semibold text-slate-700">Alto logo</label>
        <input v-model.number="form.logoH" type="number" class="w-full rounded border px-2 py-1" />
      </div>
    </div>

    <div class="rounded border border-slate-200 p-2 bg-white overflow-auto">
      <canvas ref="canvasRef" width="595" height="842" class="w-full max-w-[520px] border border-slate-200" />
    </div>

    <div class="flex items-center gap-3">
      <button class="btn-primary" :disabled="saving" @click="saveTemplate">
        {{ saving ? 'Guardando...' : 'Guardar plantilla' }}
      </button>
      <button class="btn-secondary" :disabled="saving" @click="goHome">
        Ir a inicio
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/authStore';
import { useToastStore } from '../stores/toastStore';

const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();

const saving = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const form = reactive({
  logoX: 266,
  logoY: 745,
  logoW: 62,
  logoH: 36
});

function drawPreview() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Watermark guide
  ctx.fillStyle = 'rgba(30, 64, 175, 0.05)';
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, 120, 0, Math.PI * 2);
  ctx.fill();

  // Header area
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(32, 742, canvas.width - 64, 90);

  // Logo box (center logo slot)
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(form.logoX, form.logoY, form.logoW, form.logoH);
  ctx.fillStyle = '#0f172a';
  ctx.font = '10px sans-serif';
  ctx.fillText('LOGO', form.logoX + 8, form.logoY + form.logoH / 2 + 4);
}

watch(
  () => ({ ...form }),
  () => drawPreview(),
  { deep: true }
);

onMounted(() => {
  drawPreview();
});

async function saveTemplate() {
  if (!auth.userId) {
    toast.error('Sin sesión', 'Inicia sesión nuevamente para guardar la plantilla.');
    return;
  }
  saving.value = true;
  try {
    await auth.saveUserTemplate({
      version: 1,
      page: { width: 595.28, height: 841.89 },
      logoBox: {
        x: form.logoX,
        y: form.logoY,
        width: form.logoW,
        height: form.logoH,
        fit: 'contain'
      }
    });
    toast.success('Plantilla guardada', 'Tu formato fijo ya esta activo.');
    await router.push({ name: 'home' });
  } catch (e) {
    toast.error('Error', e instanceof Error ? e.message : 'No se pudo guardar la plantilla.');
  } finally {
    saving.value = false;
  }
}

async function goHome() {
  if (!auth.templateReady) {
    toast.info('Falta plantilla', 'Primero guarda tu plantilla para continuar.');
    return;
  }
  await router.push({ name: 'home' });
}
</script>
