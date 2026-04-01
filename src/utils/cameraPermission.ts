export type CameraPreflightResult = 'granted' | 'denied' | 'unsupported';

/**
 * Solicita permiso de cámara antes de abrir el formulario de registro (evidencias con captura).
 * Libera el stream de inmediato; solo interesa disparar el prompt del navegador/OS.
 * Se intenta en cada acceso al registro (si el usuario denegó antes, puede volver a intentar o activar en ajustes).
 */
export async function preflightCameraForRegistro(): Promise<CameraPreflightResult> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'unsupported';
  }

  const m = navigator.mediaDevices;
  if (!m?.getUserMedia) {
    return 'unsupported';
  }

  try {
    let stream: MediaStream;
    try {
      stream = await m.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
    } catch {
      stream = await m.getUserMedia({ video: true });
    }
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}
