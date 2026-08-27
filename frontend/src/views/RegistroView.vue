<template>
  <div class="space-y-6">
    <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="btn-secondary p-2 sm:px-3 sm:py-2"
          aria-label="Volver"
          @click="$router.back()"
        >
          ← Volver
        </button>
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <img
            v-if="serviceLogoSrc"
            :src="serviceLogoSrc"
            alt="Logo de servicio"
            class="h-12 w-auto max-w-[140px] object-contain flex-shrink-0 border border-slate-200/80 rounded-md bg-white p-1"
          />
          <div class="min-w-0">
            <h2 class="text-xl sm:text-2xl font-bold text-slate-800">
              Nuevo registro
            </h2>
            <p class="text-sm text-slate-500 mt-0.5">
              Completa datos, checklists, inspecciones, fotos y firmas.
            </p>
          </div>
        </div>
      </div>
    </header>

    <RegistroForm />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import RegistroForm from '../components/RegistroForm.vue';
import { useAuthStore } from '../stores/authStore';
import { resolveServiceLogoUrl } from '../utils/serviceLogoUrl';

const auth = useAuthStore();

const serviceLogoSrc = ref('/logo.png');

async function refreshLogo() {
  serviceLogoSrc.value = (await resolveServiceLogoUrl(auth.serviceLogoFile || 'logo.png')) || '/logo.png';
}

onMounted(async () => {
  if (!auth.isSignedIn || !auth.userId) {
    await refreshLogo();
    return;
  }
  try {
    await auth.ensureDriveConfigIfNeeded();
  } catch {
    /* la fila user_drive_config puede cargarse después; el logo sigue con fallback */
  }
  await refreshLogo();
});

watch(
  () => auth.serviceLogoFile,
  () => {
    void refreshLogo();
  }
);
</script>
