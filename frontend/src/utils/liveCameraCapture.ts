/** Abre stream de cámara trasera (o la disponible) — solo tiempo real, sin galería. */
export async function acquireCameraStream(): Promise<MediaStream> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    throw new Error('La cámara en tiempo real no está disponible en este dispositivo.');
  }

  try {
    return await media.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
  } catch {
    return await media.getUserMedia({ video: true, audio: false });
  }
}

export function stopCameraStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Toma un frame del video y lo devuelve como archivo JPEG. */
export async function captureVideoFrameAsJpegFile(
  video: HTMLVideoElement,
  filename = `foto-${Date.now()}.jpg`,
  quality = 0.92
): Promise<File> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error('Espere a que la cámara esté lista e intente de nuevo.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo capturar la foto.');

  ctx.drawImage(video, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
  if (!blob) throw new Error('No se pudo generar la imagen.');

  return new File([blob], filename, { type: 'image/jpeg', lastModified: Date.now() });
}

export function liveCameraErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'Permiso de cámara denegado. Actívalo en la configuración del sitio y vuelve a intentar.';
    }
    if (err.name === 'NotFoundError') {
      return 'No se encontró cámara en este dispositivo.';
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return 'No se pudo usar la cámara en tiempo real.';
}
