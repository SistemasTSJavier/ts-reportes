<template>
  <div class="max-w-md mx-auto">
    <section class="card p-6 sm:p-8 space-y-5 text-center">
      <img src="/logo.png" alt="Tactical Support" class="h-14 w-14 object-contain mx-auto" />
      <div>
        <h2 class="text-lg font-bold text-slate-800">Verificación de acceso</h2>
        <p class="text-sm text-slate-500 mt-1 leading-snug">
          Cloudflare comprueba que no eres un bot. Después podrás iniciar sesión con Google.
        </p>
      </div>

      <p v-if="turnstile.status === 'verifying'" class="text-sm text-slate-600">
        Validando con el servidor…
      </p>
      <p v-else-if="turnstile.status === 'passed'" class="text-sm text-emerald-700 font-medium">
        Verificación correcta. Ya puedes iniciar sesión.
      </p>
      <p v-else-if="turnstile.error" class="text-sm text-rose-700">
        {{ turnstile.error }}
      </p>

      <div class="flex justify-center min-h-[70px]">
        <div ref="widgetHost" />
      </div>

      <button
        type="button"
        class="btn-primary w-full"
        :disabled="!turnstile.isPassed || auth.loading"
        @click="onLogin"
      >
        <span
          v-if="auth.loading"
          class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
        />
        <span v-else>Iniciar con Google</span>
      </button>

      <button
        v-if="turnstile.status === 'failed'"
        type="button"
        class="text-xs text-tactical-blue font-semibold hover:underline"
        @click="retry"
      >
        Reintentar verificación
      </button>

      <p class="text-[11px] text-slate-400">
        Protección anti-bot de Cloudflare Turnstile. No instala software en tu dispositivo.
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '../stores/authStore';
import { useToastStore } from '../stores/toastStore';
import { useTurnstileStore } from '../stores/turnstileStore';

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
        }
      ) => string;
      remove: (id: string) => void;
      reset: (id: string) => void;
    };
  }
}

const SCRIPT_ID = 'cf-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const auth = useAuthStore();
const turnstile = useTurnstileStore();
const toast = useToastStore();
const widgetHost = ref<HTMLElement | null>(null);
let widgetId: string | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('No se cargó Turnstile.')), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se cargó el script de Cloudflare Turnstile.'));
    document.head.appendChild(s);
  });
}

async function mountWidget() {
  if (!widgetHost.value || !turnstile.siteKey) return;
  if (turnstile.status === 'passed') return;
  try {
    await loadScript();
    await nextTick();
    if (!window.turnstile || !widgetHost.value) return;
    if (widgetId) {
      window.turnstile.remove(widgetId);
      widgetId = null;
    }
    widgetHost.value.innerHTML = '';
    widgetId = window.turnstile.render(widgetHost.value, {
      sitekey: turnstile.siteKey,
      theme: 'light',
      callback: (token) => {
        void turnstile.verifyToken(token);
      },
      'error-callback': () => {
        turnstile.fail('Cloudflare no pudo completar el desafío. Reintenta.');
      },
      'expired-callback': () => {
        turnstile.resetWidget();
      }
    });
  } catch (e) {
    turnstile.fail(e instanceof Error ? e.message : 'No se pudo mostrar Turnstile.');
  }
}

function unmountWidget() {
  if (widgetId && window.turnstile) {
    try {
      window.turnstile.remove(widgetId);
    } catch {
      /* ignore */
    }
  }
  widgetId = null;
}

function retry() {
  turnstile.resetWidget();
  void mountWidget();
}

async function onLogin() {
  try {
    turnstile.assertPassed();
    await auth.signInWithGoogle();
  } catch (e) {
    toast.error('Acceso', e instanceof Error ? e.message : 'Completa la verificación primero.');
  }
}

onMounted(() => {
  turnstile.hydrate();
  if (turnstile.status !== 'passed') {
    void mountWidget();
  }
});

watch(
  () => turnstile.status,
  (s) => {
    if (s === 'widget') void mountWidget();
  }
);

onBeforeUnmount(() => {
  unmountWidget();
});
</script>
