<template>
  <div class="min-h-screen flex flex-col bg-slate-50">
    <ToastContainer />

    <header class="bg-white border-b border-slate-200/80 shadow-card sticky top-0 z-10">
      <div class="max-w-4xl mx-auto px-4 sm:px-6">
        <div class="flex items-center justify-between h-16">
          <router-link
            to="/"
            class="flex items-center gap-3 text-slate-800 no-underline hover:opacity-90 transition-opacity"
          >
            <img src="/logo.png" alt="Tactical Support" class="h-9 w-9 object-contain flex-shrink-0" />
            <div>
              <h1 class="text-base font-bold text-tactical-blue uppercase tracking-wide leading-tight">
                Tactical Support
              </h1>
              <p class="text-xs text-slate-500 leading-tight">Registros</p>
            </div>
          </router-link>

          <div class="flex items-center gap-3">
            <template v-if="auth.isSignedIn">
              <div class="hidden sm:block text-right">
                <p class="text-xs text-slate-500">Conectado como</p>
                <p class="text-sm font-medium text-slate-800 truncate max-w-[160px]">
                  {{ auth.displayName || auth.email }}
                </p>
              </div>
              <button
                type="button"
                class="btn-secondary py-2 px-3 text-xs"
                @click="auth.signOut"
              >
                Cerrar sesión
              </button>
            </template>
            <template v-else>
              <button
                type="button"
                class="btn-primary py-2 px-4 text-sm"
                :disabled="auth.loading"
                @click="auth.signInWithGoogle"
              >
                <span v-if="auth.loading" class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span v-else>Iniciar con Google</span>
              </button>
            </template>
          </div>
        </div>
      </div>
    </header>

    <main class="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from './stores/authStore';
import { useSyncStore } from './stores/syncStore';
import ToastContainer from './components/ToastContainer.vue';

const auth = useAuthStore();
const sync = useSyncStore();

onMounted(() => {
  void auth.initSession();
  sync.loadFromStorage();
  sync.attachOnlineListener();
  if (navigator.onLine) {
    void sync.processQueue();
  }
});
</script>
