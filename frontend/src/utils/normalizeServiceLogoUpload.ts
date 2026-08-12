/** Formatos que la PWA acepta para el logo de servicio. */
export const SERVICE_LOGO_ACCEPT =
  'image/png,image/jpeg,image/jpg,image/webp,.png,.jpg,.jpeg,.webp';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const ALLOWED_EXT = /\.(png|jpe?g|webp)$/i;

/** Tamaño máximo de lado al normalizar (logos no necesitan resolución de foto). */
const MAX_EDGE_PX = 1024;

export function isAllowedServiceLogoFile(file: File): boolean {
  const mime = (file.type || '').toLowerCase().trim();
  if (mime && ALLOWED_MIME.has(mime)) return true;
  return ALLOWED_EXT.test(file.name || '');
}

/**
 * Convierte PNG / JPEG / JPG / WebP a PNG real (bytes) para Storage + pdf-lib.
 * El navegador decodifica WebP; canvas.toBlob('image/png') produce PNG válido.
 */
export async function normalizeServiceLogoToPng(file: File): Promise<File> {
  if (!isAllowedServiceLogoFile(file)) {
    throw new Error('Formato no soportado. Usa PNG, JPEG, JPG o WebP.');
  }

  const { width: srcW, height: srcH, draw } = await loadDrawable(file);
  const { width, height } = fitWithin(srcW, srcH, MAX_EDGE_PX);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo preparar el canvas del logo.');

  // Fondo transparente: preserva logos con alpha (PNG/WebP).
  ctx.clearRect(0, 0, width, height);
  draw(ctx, width, height);

  const blob = await canvasToPngBlob(canvas);
  if (!blob || blob.size < 32) {
    throw new Error('No se pudo convertir el logo a PNG.');
  }

  return new File([blob], 'logo.png', { type: 'image/png', lastModified: Date.now() });
}

function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const width = Math.max(1, Math.round(w || 1));
  const height = Math.max(1, Math.round(h || 1));
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

type Drawable = {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
};

async function loadDrawable(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, w, h) => {
          try {
            ctx.drawImage(bitmap, 0, 0, w, h);
          } finally {
            bitmap.close();
          }
        }
      };
    } catch {
      // fallback a <img>
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h)
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen del logo.'));
    img.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('toBlob PNG falló.'));
      },
      'image/png'
    );
  });
}
