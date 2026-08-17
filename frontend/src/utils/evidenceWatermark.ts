export interface EvidenceCaptureMeta {
  capturedAt: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracy?: number;
}

export interface EvidenceWatermarkResult {
  dataUrl: string;
  captureMeta: EvidenceCaptureMeta;
}

function formatWatermarkDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Intenta obtener coordenadas GPS (requiere Permissions-Policy geolocation=(self)). */
export async function getEvidenceCaptureGeo(): Promise<{
  latitude: number;
  longitude: number;
  accuracy?: number;
} | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  });
}

/** Dibuja sello de fecha/hora y GPS en la parte inferior de la evidencia. */
export function drawEvidenceWatermark(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  meta: EvidenceCaptureMeta
): void {
  const dateLine = formatWatermarkDate(meta.capturedAt);
  const gpsLine =
    meta.latitude != null && meta.longitude != null
      ? `${meta.latitude.toFixed(5)}, ${meta.longitude.toFixed(5)}`
      : 'GPS N/D';

  const fontSize = Math.max(12, Math.round(Math.min(canvasW, canvasH) * 0.028));
  const padX = Math.max(6, Math.round(fontSize * 0.5));
  const padY = Math.max(4, Math.round(fontSize * 0.35));
  const lineHeight = Math.round(fontSize * 1.25);

  ctx.save();
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textBaseline = 'top';

  const line1W = ctx.measureText(dateLine).width;
  const line2W = ctx.measureText(gpsLine).width;
  const barW = Math.min(canvasW - padX * 2, Math.max(line1W, line2W) + padX * 2);
  const barH = lineHeight * 2 + padY * 2;
  const barX = padX;
  const barY = canvasH - barH - padY;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(barX, barY, barW, barH);

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 2;
  ctx.fillText(dateLine, barX + padX, barY + padY);
  ctx.fillText(gpsLine, barX + padX, barY + padY + lineHeight);
  ctx.restore();
}

/** Aplica watermark sobre un canvas ya orientado y devuelve JPEG data URL. */
export async function applyEvidenceWatermarkToCanvas(
  source: HTMLCanvasElement,
  captureMeta?: Partial<EvidenceCaptureMeta>
): Promise<EvidenceWatermarkResult> {
  const capturedAt = captureMeta?.capturedAt ?? new Date().toISOString();
  let latitude = captureMeta?.latitude;
  let longitude = captureMeta?.longitude;
  let gpsAccuracy = captureMeta?.gpsAccuracy;

  if (latitude == null || longitude == null) {
    const geo = await getEvidenceCaptureGeo();
    if (geo) {
      latitude = geo.latitude;
      longitude = geo.longitude;
      gpsAccuracy = geo.accuracy;
    }
  }

  const meta: EvidenceCaptureMeta = { capturedAt, latitude, longitude, gpsAccuracy };

  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('No se pudo crear canvas para watermark');

  ctx.drawImage(source, 0, 0);
  drawEvidenceWatermark(ctx, out.width, out.height, meta);

  return {
    dataUrl: out.toDataURL('image/jpeg', 0.92),
    captureMeta: meta
  };
}
