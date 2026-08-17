<template>
  <div class="space-y-1 text-xs">
    <label class="font-semibold text-slate-700">{{ label }}</label>
    <button
      type="button"
      class="border border-dashed border-slate-300 rounded-md h-40 w-full flex items-center justify-center bg-slate-50 relative overflow-hidden cursor-pointer hover:border-tactical-blue/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      :disabled="processing"
      @click="openCamera"
    >
      <div
        v-if="!image"
        class="flex flex-col items-center gap-1 text-slate-500 text-center px-2 pointer-events-none"
      >
        <span class="text-2xl">📷</span>
        <span>Toque para tomar foto</span>
        <span class="text-[10px] text-slate-400">Cámara en tiempo real</span>
      </div>
      <template v-else>
        <img :src="image" :alt="label" class="w-full h-full object-contain pointer-events-none" />
        <span
          class="absolute bottom-1 right-1 rounded bg-black/55 px-2 py-0.5 text-[10px] text-white font-semibold"
        >
          Retomar
        </span>
      </template>
      <span
        v-if="processing"
        class="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-semibold text-slate-700"
      >
        Procesando…
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="cameraOpen"
        class="fixed inset-0 z-[100] flex flex-col bg-black"
        role="dialog"
        aria-modal="true"
        :aria-label="`Cámara: ${label}`"
      >
        <div class="flex items-center justify-between px-4 py-3 bg-black/80 text-white text-sm">
          <p class="font-semibold truncate">{{ label }}</p>
          <button type="button" class="text-white/80 hover:text-white text-xs" @click="closeCamera">
            Cancelar
          </button>
        </div>

        <div class="relative flex-1 min-h-0 bg-black">
          <video
            ref="videoRef"
            autoplay
            playsinline
            muted
            class="absolute inset-0 w-full h-full object-contain"
          />
          <div
            v-if="cameraStarting"
            class="absolute inset-0 flex items-center justify-center text-white text-sm"
          >
            Iniciando cámara…
          </div>
          <div
            v-else-if="cameraError"
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white text-sm"
          >
            <p>{{ cameraError }}</p>
            <button type="button" class="btn-secondary py-2 px-4 text-xs" @click="closeCamera">
              Cerrar
            </button>
          </div>
        </div>

        <div class="px-4 py-4 bg-black/90 flex justify-center">
          <button
            type="button"
            class="h-14 w-14 rounded-full border-4 border-white bg-white/20 hover:bg-white/30 disabled:opacity-40"
            :disabled="cameraStarting || !!cameraError || capturing"
            aria-label="Tomar foto"
            @click="takePhoto"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import {
  acquireCameraStream,
  captureVideoFrameAsJpegFile,
  liveCameraErrorMessage,
  stopCameraStream
} from '../utils/liveCameraCapture';
import { useToastStore } from '../stores/toastStore';

defineProps<{
  label: string;
  image: string;
}>();

const emit = defineEmits<{
  (e: 'capture', file: File): void;
}>();

const toast = useToastStore();

const cameraOpen = ref(false);
const cameraStarting = ref(false);
const cameraError = ref('');
const capturing = ref(false);
const processing = ref(false);
const videoRef = ref<HTMLVideoElement | null>(null);
let activeStream: MediaStream | null = null;

function closeCamera() {
  cameraOpen.value = false;
  cameraStarting.value = false;
  cameraError.value = '';
  capturing.value = false;
  stopCameraStream(activeStream);
  activeStream = null;
  if (videoRef.value) {
    videoRef.value.srcObject = null;
  }
}

async function openCamera() {
  if (processing.value) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast.error('Cámara requerida', 'Este dispositivo no permite fotos en tiempo real.');
    return;
  }

  cameraOpen.value = true;
  cameraStarting.value = true;
  cameraError.value = '';

  await nextTick();

  try {
    activeStream = await acquireCameraStream();
    const video = videoRef.value;
    if (!video) throw new Error('No se pudo mostrar la vista previa.');
    video.srcObject = activeStream;
    await video.play();
  } catch (err) {
    cameraError.value = liveCameraErrorMessage(err);
    stopCameraStream(activeStream);
    activeStream = null;
  } finally {
    cameraStarting.value = false;
  }
}

async function takePhoto() {
  const video = videoRef.value;
  if (!video || cameraStarting.value || cameraError.value || capturing.value) return;

  capturing.value = true;
  try {
    const file = await captureVideoFrameAsJpegFile(video, `evidencia-${Date.now()}.jpg`);
    processing.value = true;
    closeCamera();
    emit('capture', file);
  } catch (err) {
    toast.error('Foto', liveCameraErrorMessage(err));
  } finally {
    capturing.value = false;
    processing.value = false;
  }
}

onBeforeUnmount(() => {
  closeCamera();
});
</script>
