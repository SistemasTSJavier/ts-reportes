<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { supabase } from '../supabaseClient';
import { useAccessStore } from '../stores/accessStore';
import { useToastStore } from '../stores/toastStore';

const emit = defineEmits<{ ready: [] }>();

const access = useAccessStore();
const toast = useToastStore();

const mode = ref<'loading' | 'enroll' | 'challenge'>('loading');
const factorId = ref<string | null>(null);
const qr = ref<string | null>(null);
const secret = ref<string | null>(null);
const code = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function finishReady() {
  await supabase.auth.refreshSession();
  await access.syncContext();
  toast.success('MFA', 'Sesión admin elevada (AAL2).');
  emit('ready');
}

async function unenrollTotpFactors() {
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const all = [...(factors?.all ?? []), ...(factors?.totp ?? [])];
  const seen = new Set<string>();
  for (const f of all) {
    if (!f?.id || seen.has(f.id)) continue;
    if (f.factor_type && f.factor_type !== 'totp') continue;
    seen.add(f.id);
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
}

async function startEnroll() {
  busy.value = true;
  error.value = null;
  qr.value = null;
  secret.value = null;
  try {
    // Limpia intentos previos (verified o unverified) que bloquean el nombre.
    await unenrollTotpFactors();
    const friendlyName = `Tactical Admin ${Date.now()}`;
    const { data, error: err } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName
    });
    if (err || !data) throw err ?? new Error('No se pudo iniciar MFA');
    factorId.value = data.id;
    qr.value = data.totp.qr_code;
    secret.value = data.totp.secret;
    mode.value = 'enroll';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Error al enrolar MFA';
    mode.value = 'enroll';
  } finally {
    busy.value = false;
  }
}

async function bootstrap() {
  mode.value = 'loading';
  error.value = null;
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === 'aal2') {
    await access.syncContext();
    emit('ready');
    return;
  }
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = factors?.totp?.find((f) => f.status === 'verified');
  if (verified?.id) {
    factorId.value = verified.id;
    mode.value = 'challenge';
    return;
  }
  // Hay factor a medias o ninguno: (re)enrolar limpio.
  await startEnroll();
}

async function verifyCode() {
  if (!factorId.value || !code.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    const challenge = await supabase.auth.mfa.challenge({ factorId: factorId.value });
    if (challenge.error || !challenge.data) throw challenge.error ?? new Error('Challenge falló');
    const verified = await supabase.auth.mfa.verify({
      factorId: factorId.value,
      challengeId: challenge.data.id,
      code: code.value.trim()
    });
    if (verified.error) throw verified.error;
    await finishReady();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Código inválido';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void bootstrap();
});

watch(
  () => access.aal,
  (aal) => {
    if (aal === 'aal2') emit('ready');
  }
);
</script>

<template>
  <div class="max-w-md mx-auto rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-900">Verificación MFA (admin)</h2>
    <p class="mt-2 text-sm text-slate-600">
      El panel admin requiere autenticación de segundo factor (TOTP).
    </p>

    <p v-if="mode === 'loading'" class="mt-4 text-sm text-slate-500">Cargando…</p>

    <div v-else class="mt-4 space-y-3">
      <template v-if="mode === 'enroll'">
        <p class="text-sm text-slate-700">Escanea el QR con tu app de autenticación e introduce el código.</p>
        <img v-if="qr" :src="qr" alt="QR MFA" class="mx-auto max-w-[200px]" />
        <p v-if="secret" class="text-[11px] break-all text-slate-500">Secret: {{ secret }}</p>
        <p v-if="!qr && !busy" class="text-sm text-amber-700">
          No hay QR. Pulsa «Reiniciar MFA» e inténtalo de nuevo.
        </p>
      </template>
      <p v-else class="text-sm text-slate-700">Introduce el código de tu app autenticadora.</p>
      <input
        v-model="code"
        type="text"
        inputmode="numeric"
        maxlength="8"
        placeholder="Código de 6 dígitos"
        class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        @keyup.enter="verifyCode"
      />
      <button type="button" class="btn-primary w-full" :disabled="busy || !factorId" @click="verifyCode">
        {{ busy ? 'Verificando…' : mode === 'enroll' ? 'Activar MFA' : 'Continuar' }}
      </button>
      <button
        type="button"
        class="btn-secondary w-full text-xs"
        :disabled="busy"
        @click="startEnroll"
      >
        Reiniciar MFA (nuevo QR)
      </button>
    </div>

    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>
  </div>
</template>
