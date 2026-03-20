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
        <div>
          <h2 class="text-xl sm:text-2xl font-bold text-slate-800">
            Nuevo registro
          </h2>
          <p class="text-sm text-slate-500 mt-0.5">
            Completa datos, checklists, inspecciones, fotos y firmas.
          </p>
        </div>
      </div>
    </header>

    <RegistroForm />
  </div>
</template>

<script setup lang="ts">
import RegistroForm from '../components/RegistroForm.vue';
</script>
