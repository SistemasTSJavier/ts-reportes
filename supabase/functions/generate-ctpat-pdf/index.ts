// Supabase Edge Function - generate-ctpat-pdf
// Deno / TypeScript
// 1. Recupera el registro de la base de datos
// 2. Genera un PDF de 4 páginas (estructura basada en PdfService original)
// 3. Sube el PDF a Google Drive usando el acceso de Google del usuario (OAuth)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, degrees } from 'npm:pdf-lib@1.17.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface RegistroRow {
  id: string;
  service_id: string | null;
  folio_pdf: string | null;
  operador: string | null;
  checklist_tracto: Record<string, unknown> | null;
  checklist_caja: Record<string, unknown> | null;
  inspeccion_agricola: Record<string, unknown> | null;
  inspeccion_mecanica: Record<string, unknown> | null;
  image_urls: string[] | null;
  firma_operador: string | null;
  firma_oficial: string | null;
  evidencias_exif: Record<string, unknown> | null;
  user_id: string | null;
  created_at: string;
}

interface UserDriveConfigRow {
  pdf_folder_id: string;
  images_folder_id: string;
  service_logo_file: string | null;
}

/** Alineado con la PWA (authStore): metadata → nombre de archivo en Storage */
function normalizeServiceLogoFile(v: string | null | undefined): string {
  if (!v) return 'caterpillar.png';
  const s = v.toString().toLowerCase();
  if (s.endsWith('.png') || s.endsWith('.jpg') || s.endsWith('.jpeg')) return v.toString();
  if (s.includes('caterpillar')) return 'caterpillar.png';
  if (s.includes('komatsu')) return 'komatsu.png';
  if (s.includes('john_deere') || s.includes('john')) return 'john_deere.png';
  if (s.includes('danfoss')) return 'danfoss.png';
  return 'caterpillar.png';
}

function logoFromUserMetadata(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const raw =
    (meta.service_logo_file as string | undefined) ??
    (meta.service_logo as string | undefined) ??
    (meta.service_code as string | undefined) ??
    (meta.service as string | undefined) ??
    null;
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length ? t : null;
}

function decodeJwtSub(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const token = authorizationHeader.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : authorizationHeader;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  // base64url -> base64
  const payloadB64Url = parts[1];
  const payloadB64 = payloadB64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (payloadB64.length % 4)) % 4);

  try {
    // Decodifica con UTF-8 (evita problemas si el payload trae chars no-ASCII)
    const bin = atob(payloadB64 + padding);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const jsonStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const sub =
      (typeof parsed.sub === 'string' ? parsed.sub : null) ??
      (typeof parsed.user_id === 'string' ? parsed.user_id : null) ??
      (typeof parsed.uid === 'string' ? parsed.uid : null);

    return sub;
  } catch {
    return null;
  }
}

async function uploadToDrive(
  accessToken: string,
  fileName: string,
  bytes: Uint8Array,
  mimeType: string,
  folderId?: string
) {
  const metadata: Record<string, unknown> = {
    name: fileName,
    mimeType
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;
  const encoder = new TextEncoder();

  const part1 = encoder.encode(
    delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata)
  );
  const part2Header = encoder.encode(
    delimiter + `Content-Type: ${mimeType}\r\n\r\n`
  );
  const part3 = encoder.encode(closeDelimiter);

  const totalLength = part1.length + part2Header.length + bytes.length + part3.length;
  const multipartBody = new Uint8Array(totalLength);
  let offset = 0;
  multipartBody.set(part1, offset);
  offset += part1.length;
  multipartBody.set(part2Header, offset);
  offset += part2Header.length;
  multipartBody.set(bytes, offset);
  offset += bytes.length;
  multipartBody.set(part3, offset);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartBody
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error subiendo a Google Drive: ${text}`);
  }

  return res.json();
}

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const ROOT_FOLDER_NAME = 'TS REPORTES';
const PDF_FOLDER_NAME = 'PDFs';
const IMAGES_FOLDER_NAME = 'Evidencias';

async function findFolderId(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<string | null> {
  // Busca carpetas por nombre y parent (o root).
  // mimeType debe ser el de folder de Google Drive.
  const qParts: string[] = [
    `name='${name.replace(/'/g, "\\'")}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false'
  ];
  if (parentId) {
    qParts.push(`'${parentId}' in parents`);
  } else {
    qParts.push("'root' in parents");
  }

  const q = qParts.join(' and ');
  const res = await fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) return null;
  const data = (await res.json()) as { files?: { id: string; name: string }[] };
  const first = data.files?.[0]?.id;
  return first ?? null;
}

async function createFolder(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) {
    body.parents = [parentId];
  } else {
    body.parents = ['root'];
  }

  const res = await fetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error creando carpeta "${name}" en Drive: ${text}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function ensureDriveFolders(accessToken: string): Promise<{ pdfFolderId: string; imagesFolderId: string }> {
  const rootId = (await findFolderId(accessToken, ROOT_FOLDER_NAME)) ?? (await createFolder(accessToken, ROOT_FOLDER_NAME));

  const [pdfFolderId, imagesFolderId] = await Promise.all([
    (async () => {
      return (await findFolderId(accessToken, PDF_FOLDER_NAME, rootId)) ?? (await createFolder(accessToken, PDF_FOLDER_NAME, rootId));
    })(),
    (async () => {
      return (await findFolderId(accessToken, IMAGES_FOLDER_NAME, rootId)) ?? (await createFolder(accessToken, IMAGES_FOLDER_NAME, rootId));
    })()
  ]);

  return { pdfFolderId, imagesFolderId };
}

/** Decodifica data URL (base64) y embebe la imagen en el PDF. */
async function embedDataUrlImage(
  pdfDoc: PDFDocument,
  dataUrl: string | null | undefined
): Promise<ReturnType<PDFDocument['embedPng']> | null> {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const m = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1].trim().toLowerCase();
  const b64 = m[2];
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (mime.includes('png')) return await pdfDoc.embedPng(bytes);
    return await pdfDoc.embedJpg(bytes);
  } catch {
    return null;
  }
}

function getDataUrlMimeAndBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1].trim().toLowerCase();
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

function getJpegExifOrientation(bytes: Uint8Array): number {
  // Lee orientación EXIF en JPEG (1..8). Si no existe, retorna 1.
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;

    let offset = 2;
    while (offset + 4 < view.byteLength) {
      const marker = view.getUint16(offset, false);
      offset += 2;

      if (marker === 0xffda || marker === 0xffd9) break; // SOS/EOI
      if ((marker & 0xff00) !== 0xff00) break;

      const segmentLength = view.getUint16(offset, false);
      offset += 2;
      if (segmentLength < 2 || offset + segmentLength - 2 > view.byteLength) break;

      // APP1
      if (marker === 0xffe1 && segmentLength >= 8) {
        const exifStart = offset;
        const isExif =
          view.getUint8(exifStart) === 0x45 && // E
          view.getUint8(exifStart + 1) === 0x78 && // x
          view.getUint8(exifStart + 2) === 0x69 && // i
          view.getUint8(exifStart + 3) === 0x66; // f
        if (!isExif) return 1;

        const tiffStart = exifStart + 6; // "Exif\0\0"
        const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
        const firstIfdOffset = view.getUint32(tiffStart + 4, littleEndian);
        const ifd0 = tiffStart + firstIfdOffset;
        if (ifd0 + 2 > view.byteLength) return 1;
        const entries = view.getUint16(ifd0, littleEndian);

        for (let i = 0; i < entries; i++) {
          const entryOffset = ifd0 + 2 + i * 12;
          if (entryOffset + 12 > view.byteLength) break;
          const tag = view.getUint16(entryOffset, littleEndian);
          if (tag === 0x0112) {
            const orientation = view.getUint16(entryOffset + 8, littleEndian);
            return orientation >= 1 && orientation <= 8 ? orientation : 1;
          }
        }
        return 1;
      }

      offset += segmentLength - 2;
    }
  } catch {
    return 1;
  }

  return 1;
}

function getEvidenceOrientation(registro: RegistroRow, imageIndex: number, dataUrl: string): number {
  // 1) Preferimos orientación guardada en evidencias_exif (frontend)
  const keyByIndex = ['licencia', 'frontal', 'lateral1', 'lateral2', 'puertas_traseras', 'caja_abierta'];
  const k = keyByIndex[imageIndex];
  const exifRaw = (registro.evidencias_exif as Record<string, unknown> | null) ?? null;
  const exifEntry = exifRaw && k ? (exifRaw[k] as Record<string, unknown> | undefined) : undefined;
  const fromDb = Number(exifEntry?.orientation);
  if (Number.isFinite(fromDb) && fromDb >= 1 && fromDb <= 8) {
    return fromDb;
  }

  // 2) Fallback: leer EXIF del data URL JPEG.
  const decoded = getDataUrlMimeAndBytes(dataUrl);
  if (!decoded) return 1;
  if (!decoded.mime.includes('jpeg') && !decoded.mime.includes('jpg')) return 1;
  return getJpegExifOrientation(decoded.bytes);
}

function drawEvidenceImageWithOrientation(
  page: PDFPage,
  img: any,
  orientation: number,
  innerX: number,
  innerY: number,
  innerW: number,
  innerH: number
) {
  const srcW = Number(img.width) || 1;
  const srcH = Number(img.height) || 1;
  const swap = orientation === 6 || orientation === 8;
  const orientedW = swap ? srcH : srcW;
  const orientedH = swap ? srcW : srcH;

  const fit = Math.min(innerW / orientedW, innerH / orientedH);
  const finalW = orientedW * fit;
  const finalH = orientedH * fit;

  const x = innerX + (innerW - finalW) / 2;
  const y = innerY + (innerH - finalH) / 2;

  if (orientation === 3) {
    page.drawImage(img, {
      x: x + finalW,
      y: y + finalH,
      width: finalW,
      height: finalH,
      rotate: degrees(180)
    });
    return;
  }

  if (orientation === 6) {
    // 90° CW
    page.drawImage(img, {
      x: x + finalW,
      y,
      width: finalH,
      height: finalW,
      rotate: degrees(90)
    });
    return;
  }

  if (orientation === 8) {
    // 90° CCW
    page.drawImage(img, {
      x,
      y: y + finalH,
      width: finalH,
      height: finalW,
      rotate: degrees(-90)
    });
    return;
  }

  // 1,2,4,5,7 -> sin rotación explícita (2/4/5/7 son espejos raros en móviles)
  page.drawImage(img, {
    x,
    y,
    width: finalW,
    height: finalH
  });
}

type SupabaseForStorage = {
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Promise<{ data: Blob | null; error: Error | null }>;
    };
  };
};

async function buildPdf(
  registro: RegistroRow,
  logoCenterFile?: string | null,
  supabaseStorage?: SupabaseForStorage
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  function wrapText(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
    const lines: string[] = [];
    const words = text.split(/\s+/).filter(Boolean);
    let current = '';
    for (const w of words) {
      const next = current ? current + ' ' + w : w;
      if (font.widthOfTextAtSize(next, fontSize) <= maxWidth) {
        current = next;
      } else {
        if (current) lines.push(current);
        if (font.widthOfTextAtSize(w, fontSize) <= maxWidth) {
          current = w;
        } else {
          let rest = w;
          while (rest) {
            let fit = rest.length;
            while (fit > 0 && font.widthOfTextAtSize(rest.slice(0, fit), fontSize) > maxWidth) fit--;
            if (fit === 0) fit = 1;
            lines.push(rest.slice(0, fit));
            rest = rest.slice(fit);
          }
          current = '';
        }
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  const U = (s: string | null | undefined) => (s ?? '').toUpperCase();

  // Para Helvetica/WinAnsi: reemplazar caracteres que pueden fallar al dibujar
  const sanitizeWinAnsi = (s: string) =>
    s
      .replace(/á/g, 'a')
      .replace(/é/g, 'e')
      .replace(/í/g, 'i')
      .replace(/ó/g, 'o')
      .replace(/ú/g, 'u')
      .replace(/ñ/g, 'n')
      .replace(/Á/g, 'A')
      .replace(/É/g, 'E')
      .replace(/Í/g, 'I')
      .replace(/Ó/g, 'O')
      .replace(/Ú/g, 'U')
      .replace(/Ñ/g, 'N');

  // Cargar logos: 1) desde URL (Storage/CDN), 2) desde archivos locales
  const LOGO_BASE_URL = Deno.env.get('LOGO_BASE_URL');
  const LOGO_BUCKET = Deno.env.get('LOGO_BUCKET') ?? 'ctpat-logs';
  const logoBaseUrl = (
    LOGO_BASE_URL ||
    (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${LOGO_BUCKET}` : '')
  ).replace(/\/$/, '');

  async function loadImage(path: string) {
    const lower = path.toLowerCase();
    const isPng = lower.endsWith('.png');
    const isJpg = lower.endsWith('.jpg') || lower.endsWith('.jpeg');
    const tryEmbed = async (bytes: Uint8Array) => {
      if (isPng) return await pdfDoc.embedPng(bytes);
      if (isJpg) return await pdfDoc.embedJpg(bytes);
      return await pdfDoc.embedPng(bytes).catch(() => pdfDoc.embedJpg(bytes));
    };

    // 1) Desde URL (Supabase Storage público o LOGO_BASE_URL)
    if (logoBaseUrl) {
      try {
        const url = `${logoBaseUrl}/${path}`;
        const res = await fetch(url);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          return await tryEmbed(new Uint8Array(buf));
        }
      } catch (e) {
        console.warn('loadImage fetch failed:', path, e);
      }
    }

    // 1b) Service role: descarga desde Storage (bucket privado o fallo de URL pública)
    if (supabaseStorage) {
      try {
        const { data: blob, error: dlErr } = await supabaseStorage.storage.from(LOGO_BUCKET).download(path);
        if (!dlErr && blob) {
          const buf = await blob.arrayBuffer();
          return await tryEmbed(new Uint8Array(buf));
        }
      } catch (e) {
        console.warn('loadImage storage.download failed:', path, e);
      }
    }

    // 2) Desde archivos locales (./assets o cwd/assets)
    try {
      const url = new URL(`./assets/${path}`, import.meta.url);
      const data = await Deno.readFile(url);
      return await tryEmbed(data);
    } catch {
      try {
        const data = await Deno.readFile(`${Deno.cwd()}/assets/${path}`);
        return await tryEmbed(data);
      } catch (e) {
        console.warn('loadImage file failed:', path, e);
        return null;
      }
    }
  }

  const logoLeft = await loadImage('ctpat.png'); // siempre lado izquierdo

  // Logo de la empresa en el centro:
  // 1) si existe `logoCenterFile` (por usuario/servicio) lo usamos
  // 2) si no, caemos al fallback basado en `service_id` del registro
  const serviceLogoFile = (() => {
    const direct = (logoCenterFile ?? '').toString().trim();
    if (direct) return direct;
    const s = (registro.service_id ?? '').toString().toLowerCase();
    if (s.includes('caterpillar')) return 'caterpillar.png';
    if (s.includes('komatsu')) return 'komatsu.png';
    if (s.includes('john_deere') || s.includes('john')) return 'john_deere.png';
    if (s.includes('danfoss')) return 'danfoss.png';
    return 'caterpillar.png';
  })();
  const logoCenter = await loadImage(serviceLogoFile);

  const logoRight = await loadImage('oea.jpeg'); // siempre lado derecho
  const logoWatermark = await loadImage('logo.png'); // fondo de cada página

  const page1 = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page1.getSize();
  const mechHabilitadaGlobal = ((registro.inspeccion_mecanica as any)?.habilitada ?? false) === true;

  // Fondo de agua (logo centrado, muy tenue)
  if (logoWatermark) {
    const wmDims = logoWatermark.scale(0.5);
    page1.drawImage(logoWatermark, {
      x: width / 2 - wmDims.width / 2,
      y: height / 2 - wmDims.height / 2,
      width: wmDims.width,
      height: wmDims.height,
      opacity: 0.05
    });
  }

  // Encabezado pegado al borde superior (margen mínimo)
  const topMargin = 8;
  let cursorY = height - topMargin;

  // ==== Encabezado (banda gris + borde azul) ====
  const headerHeight = 90;
  page1.drawRectangle({
    x: 32,
    y: cursorY - headerHeight,
    width: width - 64,
    height: headerHeight,
    color: rgb(0.95, 0.95, 0.95),
    borderColor: rgb(0, 0.3, 0.7),
    borderWidth: 0
  });
  page1.drawRectangle({
    x: 32,
    y: cursorY - headerHeight,
    width: width - 64,
    height: 2,
    color: rgb(0, 0.3, 0.7)
  });

  // 1) Logos arriba (misma disposición: izquierda, centro, derecha)
  const logoWidth = 70;
  const logoHeight = 45;
  const logosGapFromTop = 12;
  const logosY = cursorY - logosGapFromTop - logoHeight / 2;
  const leftX = 32 + 10;
  const rightX = width - 32 - 10 - logoWidth;
  const centerX = width / 2 - logoWidth / 2;

  if (logoLeft) {
    page1.drawImage(logoLeft, {
      x: leftX,
      y: logosY - logoHeight / 2,
      width: logoWidth,
      height: logoHeight
    });
  }
  if (logoCenter) {
    page1.drawImage(logoCenter, {
      x: centerX,
      y: logosY - logoHeight / 2,
      width: logoWidth,
      height: logoHeight
    });
  }
  if (logoRight) {
    page1.drawImage(logoRight, {
      x: rightX,
      y: logosY - logoHeight / 2,
      width: logoWidth,
      height: logoHeight
    });
  }

  // 2) Título debajo de los logos, centrado
  const entrada =
    (registro.checklist_tracto?.datos_generales as any)?.entradaSalida === 'Entrada' ||
    (registro as any).entrada_salida === 'Entrada';
  const titulo = entrada
    ? 'CHECKLIST DE REPORTE DE ENTRADA DE TRANSPORTE'
    : 'CHECKLIST DE REPORTE DE SALIDA DE TRANSPORTE';
  const fontSizeTitle = 12;
  const titleGapBelowLogos = 10;
  const titleY = logosY - logoHeight / 2 - titleGapBelowLogos - fontSizeTitle;

  const titleWidth = fontBold.widthOfTextAtSize(U(titulo), fontSizeTitle);
  page1.drawText(U(titulo), {
    x: width / 2 - titleWidth / 2,
    y: titleY,
    size: fontSizeTitle,
    font: fontBold,
    color: rgb(0, 0.2, 0.6)
  });

  // 3) Folio a la derecha, misma línea que el título (ej. Folio: TS-004)
  const rawFolio = (registro.folio_pdf ?? '').toString().trim();
  const folioDisplay =
    rawFolio.replace(/^TS-0*(\d+)$/i, (_, n) => `TS-${String(Number(n))}`) ||
    rawFolio ||
    '';
  const folioText = folioDisplay ? `Folio: ${folioDisplay}` : '';
  const folioFontSize = 11;
  const folioWidth = folioText ? fontBold.widthOfTextAtSize(folioText, folioFontSize) : 0;
  if (folioText) {
    page1.drawText(folioText, {
      x: width - 32 - folioWidth,
      y: titleY,
      size: folioFontSize,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });
  }

  cursorY = cursorY - headerHeight - 15;

  const marginX = 32;
  const tableWidth = width - marginX * 2;
  const labelWidth = tableWidth * 0.35;
  const valueWidth = tableWidth * 0.65;
  const rowHeight = 16;
  const fontSizeBody = 9;
  const sectionTitleHeight = 18;

  function drawSectionTitleP1(title: string) {
    page1.drawRectangle({
      x: marginX,
      y: cursorY - sectionTitleHeight,
      width: tableWidth,
      height: sectionTitleHeight,
      color: rgb(0.92, 0.92, 0.92)
    });
    page1.drawRectangle({
      x: marginX,
      y: cursorY - sectionTitleHeight,
      width: 4,
      height: sectionTitleHeight,
      color: rgb(0, 0.2, 0.6)
    });
    page1.drawText(U(title), {
      x: marginX + 10,
      y: cursorY - sectionTitleHeight + 5,
      size: 11,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });
    cursorY -= sectionTitleHeight + 8;
  }

  // ---- 1. FECHA (como en el formulario) ----
  drawSectionTitleP1('FECHA');
  const fechaText = (() => {
    const fechaIso =
      (registro.checklist_tracto?.datos_generales as any)?.fecha ?? registro.created_at;
    const d = new Date(fechaIso);
    const dd = d.getDate().toString().padStart(2, '0');
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = d.getHours().toString().padStart(2, '0');
    const mi = d.getMinutes().toString().padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  })();
  page1.drawText('Fecha y hora:', {
    x: marginX,
    y: cursorY - 12,
    size: fontSizeBody,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  page1.drawText(fechaText, {
    x: marginX + fontBold.widthOfTextAtSize('Fecha y hora: ', fontSizeBody),
    y: cursorY - 12,
    size: fontSizeBody,
    font: fontRegular,
    color: rgb(0, 0, 0)
  });
  cursorY -= 20;

  // ---- 2. DATOS PERSONALES / GENERALES (tabla, sin Comentarios; Comentarios va en su sección más adelante) ----
  drawSectionTitleP1('DATOS PERSONALES / GENERALES');
  const dg = (registro.checklist_tracto?.datos_generales as any) ?? {};

  function drawRow(label: string, value: string, rowIndex: number) {
    const y = cursorY - rowHeight * (rowIndex + 1);

    // Fondo gris claro en label
    page1.drawRectangle({
      x: marginX,
      y,
      width: labelWidth,
      height: rowHeight,
      color: rgb(0.95, 0.95, 0.95),
      borderColor: rgb(0.8, 0.8, 0.8),
      borderWidth: 0.5
    });

    // Casilla valor
    page1.drawRectangle({
      x: marginX + labelWidth,
      y,
      width: valueWidth,
      height: rowHeight,
      borderColor: rgb(0.8, 0.8, 0.8),
      borderWidth: 0.5
    });

    const padX = 4;

    page1.drawText(U(label), {
      x: marginX + padX,
      y: y + 3,
      size: fontSizeBody,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    page1.drawText(U(value), {
      x: marginX + labelWidth + padX,
      y: y + 3,
      size: fontSizeBody,
      font: fontRegular,
      color: rgb(0, 0, 0)
    });
  }

  const rows: Array<[string, string]> = [
    ['Responsable', dg.responsable ?? ''],
    ['Operador', registro.operador ?? ''],
    ['Tipo de licencia', dg.tipoLicencia || '-'],
    ['Número de Tracto', dg.numeroTracto || '-'],
    ['Vacia/Cargada', dg.vaciaCargada || ''],
    ['Medidas de la caja', dg.medidasCaja || '-'],
    ['Línea Transportista', dg.lineaTransportista || ''],
    ['Línea', dg.lineaTipo || ''],
    ['Número de Caja', dg.numeroCaja || ''],
    ['Sello', dg.sello || ''],
    ['No. de placas (Tracto)', dg.placasTracto || ''],
    ['No. de placas (Caja)', dg.placasCaja || ''],
    ['Origen', dg.origen || '-']
  ];

  // Bordes externos de la tabla
  const tableHeight = rowHeight * rows.length;
  page1.drawRectangle({
    x: marginX,
    y: cursorY - tableHeight,
    width: tableWidth,
    height: tableHeight,
    borderColor: rgb(0.5, 0.5, 0.5),
    borderWidth: 0.7
  });

  rows.forEach((r, idx) => drawRow(r[0], r[1], idx));

  cursorY = cursorY - tableHeight - 20;

  // ---- 3. CHECKLIST TRACTO y 4. CHECKLIST CAJA (títulos van en cada columna) ----
  cursorY -= 8;
  // ==== Checklists: Tracto y Caja ====
  const checklistTopY = cursorY;
  const colGap = 16;
  const checklistColWidth = (tableWidth - colGap) / 2;
  const boxSize = 10;
  const lineGap = 14;
  const fontSizeChk = 8;

  function drawChecklistColumn(
    title: string,
    items: string[],
    values: Record<string, unknown> | null | undefined,
    startIndex: number,
    x: number,
    yTop: number
  ) {
    // contenedor
    const borderPadding = 6;
    const contentX = x + borderPadding;
    let cy = yTop - borderPadding;

    // título
    const titleText = U(title);
    const titleW = fontBold.widthOfTextAtSize(titleText, fontSizeChk + 1);
    page1.drawText(titleText, {
      x: x + (checklistColWidth - titleW) / 2,
      y: cy - fontSizeChk - 1,
      size: fontSizeChk + 1,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    cy -= fontSizeChk + 6;

    items.forEach((label, idx) => {
      const checked = !!(values && (values as any)[label] === true);
      const boxYItem = cy - boxSize + 3;

      // cajita
      page1.drawRectangle({
        x: contentX,
        y: boxYItem,
        width: boxSize,
        height: boxSize,
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 0.5
      });
      if (checked) {
        // dibujar "palomita"
        const boxX = contentX;
        page1.drawLine({
          start: { x: boxX + 2, y: boxYItem + 4 },
          end: { x: boxX + 4.2, y: boxYItem + 2 },
          thickness: 0.7,
          color: rgb(0, 0, 0)
        });
        page1.drawLine({
          start: { x: boxX + 4.2, y: boxYItem + 2 },
          end: { x: boxX + boxSize - 2, y: boxYItem + boxSize - 1.2 },
          thickness: 0.7,
          color: rgb(0, 0, 0)
        });
      }

      // Texto en una sola línea como el checklist mecánico (mismo “row layout”).
      const lineText = `${startIndex + idx}. ${label.replace(/_/g, ' ')}`;
      page1.drawText(U(lineText), {
        x: contentX + boxSize + 4,
        y: cy - fontSizeChk,
        size: fontSizeChk,
        font: fontRegular,
        color: rgb(0, 0, 0)
      });

      cy -= lineGap;
    });

    // borde del contenedor
    const contentHeight = yTop - cy + borderPadding;
    page1.drawRectangle({
      x,
      y: yTop - contentHeight,
      width: checklistColWidth,
      height: contentHeight,
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 0.6
    });
  }

  const tractoItems = [
    'DEFENSA',
    'MOTOR',
    'LLANTAS',
    'CABINA',
    'PISO_INTERIOR',
    'BATERIA',
    'TANQUE_DE_AIRE',
    'TANQUE_DE_COMBUSTIBLE',
    'QUINTA_RUEDA',
    'ESCAPE'
  ];
  const cajaItems = [
    'PUERTAS',
    'PISO_INTERIOR',
    'PAREDES_LATERALES',
    'PARED_FRONTAL',
    'TECHO',
    'UNIDAD_DE_REFRIGERACION',
    'PARED_DE_FONDO'
  ];

  const tractoValues = registro.checklist_tracto || {};
  const cajaValues = registro.checklist_caja || {};

  const leftChecklistX = marginX;
  const rightChecklistX = marginX + checklistColWidth + colGap;

  drawChecklistColumn(
    'CHECKLIST TRACTO',
    tractoItems,
    tractoValues,
    1,
    leftChecklistX,
    checklistTopY
  );

  drawChecklistColumn(
    'CHECKLIST CAJA',
    cajaItems,
    cajaValues,
    11,
    rightChecklistX,
    checklistTopY
  );

  // Si NO está habilitada la inspección mecánica, ignoramos la hoja 3 y pasamos
  // las firmas a la hoja 1 en el espacio debajo del checklist (sin tocar el resto).
  if (!mechHabilitadaGlobal) {
    const tractoContentHeight = tractoItems.length * lineGap + 26;
    const checklistBottomY = checklistTopY - tractoContentHeight;

    const sigGapMech = 24;
    const sigBoxW = (tableWidth - sigGapMech) / 2;
    const sigBoxH = 86;
    const titleH = 18;
    const titleGapBelow = 8;
    const gapBetweenChecklistAndTitle = 10;
    const minSigBottomY = 42; // para no invadir el pie en y=32

    // Bloque: [titleH] + [titleGapBelow] + [sigBoxH]
    let titleBarTopY = checklistBottomY - gapBetweenChecklistAndTitle;
    let titleBarBottomY = titleBarTopY - titleH;
    let sigBottomY = titleBarBottomY - titleGapBelow - sigBoxH;

    // Si el cálculo cae muy abajo, desplazamos el bloque completo hacia arriba.
    if (sigBottomY < minSigBottomY) {
      const delta = minSigBottomY - sigBottomY;
      sigBottomY += delta;
      titleBarBottomY += delta;
      titleBarTopY += delta;
    }

    // Título "FIRMAS A DIVIDIR"
    page1.drawRectangle({
      x: marginX,
      y: titleBarBottomY,
      width: tableWidth,
      height: titleH,
      color: rgb(0.92, 0.92, 0.92)
    });
    page1.drawRectangle({
      x: marginX,
      y: titleBarBottomY,
      width: 4,
      height: titleH,
      color: rgb(0, 0.2, 0.6)
    });
    page1.drawText(U('FIRMAS A DIVIDIR'), {
      x: marginX + 10,
      y: titleBarBottomY + 5,
      size: 11,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });

    const sigOp = await embedDataUrlImage(pdfDoc, registro.firma_operador);
    const sigOf = await embedDataUrlImage(pdfDoc, registro.firma_oficial);

    const sig1X = marginX;
    const sig2X = marginX + sigBoxW + sigGapMech;

    const drawSignatureBoxP1 = (
      x: number,
      label1: string,
      label2: string,
      sigImg: any
    ) => {
      page1.drawRectangle({
        x,
        y: sigBottomY,
        width: sigBoxW,
        height: sigBoxH,
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 0.5
      });

      const lines1 = wrapText(U(label1), sigBoxW - 10, fontBold, 8);
      const lines2 = wrapText(U(label2), sigBoxW - 10, fontRegular, 7);

      let textY = sigBottomY + sigBoxH - 14;
      for (const line of lines1) {
        const lw = fontBold.widthOfTextAtSize(line, 8);
        page1.drawText(line, {
          x: x + (sigBoxW - lw) / 2,
          y: textY,
          size: 8,
          font: fontBold,
          color: rgb(0, 0, 0)
        });
        textY -= 10;
      }

      for (const line of lines2) {
        const lw = fontRegular.widthOfTextAtSize(line, 7);
        page1.drawText(line, {
          x: x + (sigBoxW - lw) / 2,
          y: textY,
          size: 7,
          font: fontRegular,
          color: rgb(0, 0, 0)
        });
        textY -= 9;
      }

      if (sigImg) {
        const imgAreaH = sigBoxH - 44;
        const dims = sigImg.scaleToFit(sigBoxW - 16, imgAreaH);
        page1.drawImage(sigImg, {
          x: x + (sigBoxW - dims.width) / 2,
          y: sigBottomY + 10 + (imgAreaH - dims.height) / 2,
          width: dims.width,
          height: dims.height
        });
      }
    };

    drawSignatureBoxP1(sig1X, 'FIRMA DEL OPERADOR', '(DIBUJAR AQUÍ)', sigOp);
    drawSignatureBoxP1(sig2X, 'FIRMA DEL OFICIAL QUE REALIZA LA INSPECCIÓN', '(DIBUJAR AQUÍ)', sigOf);
  }

  // Pie de página página 1
  const dGen = new Date(registro.created_at);
  const dd2 = dGen.getDate().toString().padStart(2, '0');
  const mm2 = (dGen.getMonth() + 1).toString().padStart(2, '0');
  const yyyy2 = dGen.getFullYear();
  const footerText = `Reporte generado el ${dd2}/${mm2}/${yyyy2}`;
  const footerSize = 8;
  const footerWidth = fontRegular.widthOfTextAtSize(footerText, footerSize);
  page1.drawText(footerText, {
    x: width / 2 - footerWidth / 2,
    y: 32,
    size: footerSize,
    font: fontRegular,
    color: rgb(0.4, 0.4, 0.4)
  });

  // ========== PÁGINA 2: Cheklist Inspección Agrícola + Puntos de verificación del tracto ==========
  const page2 = pdfDoc.addPage([595.28, 841.89]);
  const height2 = page2.getSize().height;
  if (logoWatermark) {
    const wmDims = logoWatermark.scale(0.5);
    page2.drawImage(logoWatermark, {
      x: width / 2 - wmDims.width / 2,
      y: height2 / 2 - wmDims.height / 2,
      width: wmDims.width,
      height: wmDims.height,
      opacity: 0.05
    });
  }

  const secH2 = 18;
  let cy = height2 - 36;

  // Barra de título: "Cheklist (Inspección Agrícola de Caja Trailer)" (fondo gris + barra azul)
  page2.drawRectangle({
    x: marginX,
    y: cy - secH2,
    width: tableWidth,
    height: secH2,
    color: rgb(0.92, 0.92, 0.92)
  });
  page2.drawRectangle({
    x: marginX,
    y: cy - secH2,
    width: 4,
    height: secH2,
    color: rgb(0, 0.2, 0.6)
  });
  page2.drawText(U('Cheklist (Inspección Agrícola de Caja Trailer)'), {
    x: marginX + 10,
    y: cy - secH2 + 5,
    size: 11,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  // Folio en todas las páginas
  if (folioText) {
    page2.drawText(folioText, {
      x: width - 32 - folioWidth,
      y: cy - secH2 + 5,
      size: folioFontSize,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });
  }
  cy -= secH2 + 12;

  const INSPECCION_AGRICOLA_ACTIVIDADES: { id: string; descripcion: string }[] = [
    {
      id: '1',
      descripcion:
        'VERIFICAR QUE EL EQUIPO DE TRANSPORTE SE ENCUENTRE LIBRE DE INSECTOS U OTROS INVERTEBRADOS (VIVOS O MUERTOS, EN CUALQUIER ETAPA DEL CICLO DE VIDA, INCLUIDAS LAS CÁSCARAS DE HUEVO)'
    },
    {
      id: '2',
      descripcion:
        'VERIFICAR QUE EL TRANSPORTE SE ENCUENTRE LIBRE DE MATERIAL ORGÁNICO DE ORIGEN ANIMAL (SANGRE, HUESOS, PELO, CARNE, SECRECIONES, EXCRECIONES)'
    },
    {
      id: '3',
      descripcion:
        'VERIFICAR QUE EL EQUIPO DE TRANSPORTE SE ENCUENTRE LIBRE DE PLANTAS O PRODUCTOS VEGETALES (FRUTAS, SEMILLAS, HOJAS, RAMAS, RAÍCES, CORTEZA)'
    },
    {
      id: '4',
      descripcion:
        'VERIFICAR QUE EL EQUIPO DE TRANSPORTE SE ENCUENTRE LIBRE DE OTROS MATERIALES ORGÁNICOS (HONGOS, TIERRA, AGUA)'
    }
  ];

  const ia = (registro.inspeccion_agricola ?? {}) as Record<string, unknown>;
  const iaVerificado = (ia.verificado as Record<string, boolean>) ?? {};
  const iaContaminacion = (ia.contaminacion as Record<string, string>) ?? {};
  const lineH = 10;
  const blockGap = 16;
  const fieldH = 14;
  const descMaxWidth = tableWidth - 8;

  for (const act of INSPECCION_AGRICOLA_ACTIVIDADES) {
    const verificado = iaVerificado[act.id] === true;
    const contRaw = (iaContaminacion[act.id] ?? '').toString().trim();
    const contText = contRaw ? U(contRaw) : 'SIN COMENTARIO';

    // Título: ACTIVIDAD REQUERIDA X
    page2.drawText(U(`ACTIVIDAD REQUERIDA ${act.id}`), {
      x: marginX,
      y: cy,
      size: 10,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    cy -= lineH + 2;

    // Descripción de la actividad (siempre la del listado; varias líneas si hace falta)
    const descripcionTexto = act.descripcion ?? '';
    const descripcionSafe = sanitizeWinAnsi(U(descripcionTexto));
    const descLines = wrapText(descripcionSafe, descMaxWidth, fontRegular, 9);
    for (const line of descLines) {
      page2.drawText(line, {
        x: marginX,
        y: cy,
        size: 9,
        font: fontRegular,
        color: rgb(0, 0, 0)
      });
      cy -= lineH;
    }
    cy -= 4;

    // VALIDACIÓN: [VERIFICADO/NO VERIFICADO] en área tipo campo
    page2.drawRectangle({
      x: marginX,
      y: cy - fieldH,
      width: tableWidth,
      height: fieldH,
      color: rgb(0.98, 0.98, 0.98),
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 0.5
    });
    page2.drawText('VALIDACIÓN: ', {
      x: marginX + 4,
      y: cy - fieldH + 4,
      size: 9,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    page2.drawText(verificado ? 'VERIFICADO' : 'NO VERIFICADO', {
      x: marginX + 4 + fontBold.widthOfTextAtSize('VALIDACIÓN: ', 9),
      y: cy - fieldH + 4,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0)
    });
    cy -= fieldH + 4;

    // TIPO DE CONTAMINACIÓN DETECTADA [valor] en área tipo campo
    page2.drawRectangle({
      x: marginX,
      y: cy - fieldH,
      width: tableWidth,
      height: fieldH,
      color: rgb(0.98, 0.98, 0.98),
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 0.5
    });
    page2.drawText('TIPO DE CONTAMINACIÓN DETECTADA ', {
      x: marginX + 4,
      y: cy - fieldH + 4,
      size: 9,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    const labelContWidth = fontBold.widthOfTextAtSize('TIPO DE CONTAMINACIÓN DETECTADA ', 9);
    page2.drawText(contText, {
      x: marginX + 4 + labelContWidth,
      y: cy - fieldH + 4,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0)
    });
    cy -= fieldH + blockGap;
  }

  cy -= 6;
  // Título centrado: PUNTOS DE VERIFICACIÓN DEL TRACTO (más grande y en negrita)
  const tituloTracto = 'PUNTOS DE VERIFICACIÓN DEL TRACTO';
  const tituloTractoW = fontBold.widthOfTextAtSize(tituloTracto, 13);
  page2.drawText(tituloTracto, {
    x: marginX + (tableWidth - tituloTractoW) / 2,
    y: cy,
    size: 13,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  cy -= 20;

  const diagramWidth = 300;
  try {
    const cajaImg = await loadImage('caja.jpg');
    if (cajaImg) {
      const dims = cajaImg.scaleToFit(diagramWidth, diagramWidth);
      const diagramX = marginX + (tableWidth - dims.width) / 2;
      const diagramY = cy - dims.height;
      page2.drawImage(cajaImg, {
        x: diagramX,
        y: diagramY,
        width: dims.width,
        height: dims.height
      });
      cy = diagramY - 16;
    }
  } catch {
    // Si falla o no hay imagen, no se coloca; no lanzar error
  }

  page2.drawText(footerText, {
    x: width / 2 - footerWidth / 2,
    y: 32,
    size: footerSize,
    font: fontRegular,
    color: rgb(0.4, 0.4, 0.4)
  });

  // ========== PÁGINA 3: Inspección mecánica, evidencias y firmas ==========
  // Si el checklist mecánico NO está habilitado, ignoramos completamente la hoja 3.
  if (mechHabilitadaGlobal) {
    const page3 = pdfDoc.addPage([595.28, 841.89]);
    const height3 = page3.getSize().height;
    if (mechHabilitadaGlobal && logoWatermark) {
      const wmDims = logoWatermark.scale(0.5);
      page3.drawImage(logoWatermark, {
        x: width / 2 - wmDims.width / 2,
        y: height3 / 2 - wmDims.height / 2,
        width: wmDims.width,
        height: wmDims.height,
        opacity: 0.05
      });
    }

  let cy3 = height3 - 40;
  // Folio en la esquina superior derecha (mismo folio en todas las páginas).
  if (folioText) {
    page3.drawText(folioText, {
      x: width - 32 - folioWidth,
      y: height3 - 20,
      size: folioFontSize,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });
  }
  const secH = 18;
  const drawSectionTitleP3 = (title: string) => {
    page3.drawRectangle({
      x: marginX,
      y: cy3 - secH,
      width: tableWidth,
      height: secH,
      color: rgb(0.92, 0.92, 0.92)
    });
    page3.drawRectangle({
      x: marginX,
      y: cy3 - secH,
      width: 4,
      height: secH,
      color: rgb(0, 0.2, 0.6)
    });
    page3.drawText(U(title), {
      x: marginX + 10,
      y: cy3 - secH + 5,
      size: 11,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });
    cy3 -= secH + 8;
  };

  // --- Inspección mecánica (CHECKLIST + OBSERVACIONES + FIRMAS) ---
  const im = (registro.inspeccion_mecanica ?? {}) as Record<string, unknown>;
  const imTractor = (im.tractor as Record<string, boolean>) ?? {};
  const imCaja = (im.cajaTrailer as Record<string, boolean>) ?? {};
  const imObsRaw = ((im.observaciones as string) ?? '').trim();
  const imObs = imObsRaw ? imObsRaw : 'SIN COMENTARIOS';

  // Solo dibujar la sección mecánica si está habilitada en el formulario.
  const mechHabilitada = mechHabilitadaGlobal;

  if (mechHabilitada) {
    // Título como en Flutter
    drawSectionTitleP3('CHECKLIST INSPECCIÓN MECÁNICA DE TRACTOR Y CAJA TRAILER');

    const mechColGap = 16;
    const mechColW = (tableWidth - mechColGap) / 2;
    const checkboxSizeMech = 10;
    const rowHMech = 14;
    const fontSizeMech = 9;

    const tractorKeys = [
      'LUCES_FRONTALES',
      'DIRECCIONALES',
      'LUCES_LATERALES',
      'LUCES_TRASERAS',
      'INTERMITENTES',
      'CABINA',
      'VIDRIO_FRONTAL',
      'VIDRIO_IZQUIERDO',
      'VIDRIO_DERECHO'
    ];
    const cajaKeys = [
      'LUCES_TRASERAS',
      'MANITAS',
      'PATINES_MANIVELA',
      'COPLES',
      'GOMAS',
      'BISAGRAS_SOLDADAS',
      'LUZ_DE_PLACA',
      'LODERA_IZQUIERDA',
      'LODERA_DERECHA'
    ];

    function drawMechChecklistColumn(
      title: string,
      x: number,
      keys: string[],
      values: Record<string, boolean>
    ) {
      const boxPaddingX = 12;
      const boxH = 28 + keys.length * rowHMech + 6;
      const boxY = cy3 - boxH;

      // Contenedor del checklist
      page3.drawRectangle({
        x,
        y: boxY,
        width: mechColW,
        height: boxH,
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 0.6
      });

      // Título de columna
      const titleText = U(title);
      const titleW = fontBold.widthOfTextAtSize(titleText, fontSizeMech);
      page3.drawText(U(title), {
        x: x + (mechColW - titleW) / 2,
        y: cy3 - 10,
        size: fontSizeMech,
        font: fontBold,
        color: rgb(0, 0, 0)
      });

      // Filas
      let cyItem = cy3 - 34;
      keys.forEach((k, idx) => {
        const checked = values[k] === true;
        const boxX = x + boxPaddingX;
        const boxYItem = cyItem - checkboxSizeMech + 3;

        // Checkbox
        page3.drawRectangle({
          x: boxX,
          y: boxYItem,
          width: checkboxSizeMech,
          height: checkboxSizeMech,
          borderColor: rgb(0.6, 0.6, 0.6),
          borderWidth: 0.5
        });

        if (checked) {
          // Palomita
          page3.drawLine({
            start: { x: boxX + 2, y: boxYItem + 4 },
            end: { x: boxX + 4.2, y: boxYItem + 2 },
            thickness: 0.7,
            color: rgb(0, 0, 0)
          });
          page3.drawLine({
            start: { x: boxX + 4.2, y: boxYItem + 2 },
            end: { x: boxX + checkboxSizeMech - 2, y: boxYItem + checkboxSizeMech - 1.2 },
            thickness: 0.7,
            color: rgb(0, 0, 0)
          });
        }

        const label = `${idx + 1}. ${k.replace(/_/g, ' ')}`;
        page3.drawText(U(label), {
          x: boxX + checkboxSizeMech + 4,
          y: cyItem - fontSizeMech,
          size: fontSizeMech,
          font: fontRegular,
          color: rgb(0, 0, 0)
        });

        cyItem -= rowHMech;
      });
    }

    // Checklist columnas
    const mechTopCy = cy3;
    drawMechChecklistColumn('TRACTOR', marginX, tractorKeys, imTractor);
    drawMechChecklistColumn('CAJA TRAILER', marginX + mechColW + mechColGap, cajaKeys, imCaja);

    // Actualizar cy3 para seguir debajo de ambos boxes
    const mechBoxH = 20 + tractorKeys.length * rowHMech + 2;
    cy3 = mechTopCy - mechBoxH - 14;

    // Observaciones
    drawSectionTitleP3('OBSERVACIONES');
    const obsBoxH = 52;
    const obsBottomY = cy3 - obsBoxH;
    page3.drawRectangle({
      x: marginX,
      y: obsBottomY,
      width: tableWidth,
      height: obsBoxH,
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 0.6
    });

    const obsLines = wrapText(sanitizeWinAnsi(U(imObs)), tableWidth - 16, fontRegular, 9);
    let obsCy = cy3 - 18;
    obsLines.slice(0, 5).forEach((line) => {
      page3.drawText(line, {
        x: marginX + 8,
        y: obsCy,
        size: 9,
        font: fontRegular,
        color: rgb(0, 0, 0)
      });
      obsCy -= 11;
    });
    cy3 -= obsBoxH + 14;

    // Firmas
    drawSectionTitleP3('FIRMAS A DIVIDIR');
    const sigGapMech = 24;
    const sigBoxW = (tableWidth - sigGapMech) / 2;
    const sigBoxH = 86;
    const sigBottomY = cy3 - sigBoxH;

    const sigOp = await embedDataUrlImage(pdfDoc, registro.firma_operador);
    const sigOf = await embedDataUrlImage(pdfDoc, registro.firma_oficial);

    const sig1X = marginX;
    const sig2X = marginX + sigBoxW + sigGapMech;

    const drawSignatureBox = (
      x: number,
      label1: string,
      label2: string,
      sigImg: any
    ) => {
      page3.drawRectangle({
        x,
        y: sigBottomY,
        width: sigBoxW,
        height: sigBoxH,
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 0.5
      });

      // Texto superior envuelto para que no se corte (importante con “FIRMA DEL OFICIAL...”)
      const lines1 = wrapText(U(label1), sigBoxW - 10, fontBold, 8);
      const lines2 = wrapText(U(label2), sigBoxW - 10, fontRegular, 7);

      let textY = sigBottomY + sigBoxH - 14;
      for (const line of lines1) {
        const lw = fontBold.widthOfTextAtSize(line, 8);
        page3.drawText(line, {
          x: x + (sigBoxW - lw) / 2,
          y: textY,
          size: 8,
          font: fontBold,
          color: rgb(0, 0, 0)
        });
        textY -= 10;
      }

      for (const line of lines2) {
        const lw = fontRegular.widthOfTextAtSize(line, 7);
        page3.drawText(line, {
          x: x + (sigBoxW - lw) / 2,
          y: textY,
          size: 7,
          font: fontRegular,
          color: rgb(0, 0, 0)
        });
        textY -= 9;
      }

      if (sigImg) {
        const imgAreaH = sigBoxH - 44;
        const dims = sigImg.scaleToFit(sigBoxW - 16, imgAreaH);
        page3.drawImage(sigImg, {
          x: x + (sigBoxW - dims.width) / 2,
          y: sigBottomY + 10 + (imgAreaH - dims.height) / 2,
          width: dims.width,
          height: dims.height
        });
      }
    };

    drawSignatureBox(
      sig1X,
      'FIRMA DEL OPERADOR',
      '(DIBUJAR AQUÍ)',
      sigOp
    );
    drawSignatureBox(
      sig2X,
      'FIRMA DEL OFICIAL QUE REALIZA LA INSPECCIÓN',
      '(DIBUJAR AQUÍ)',
      sigOf
    );

    cy3 = sigBottomY - 14;

    // --- Comentarios (solo si existen) ---
    const comentariosRaw = (registro as any).comentarios;
    const comentariosTrim =
      typeof comentariosRaw === 'string'
        ? comentariosRaw.trim()
        : comentariosRaw != null
          ? String(comentariosRaw).trim()
          : '';

    if (comentariosTrim) {
      drawSectionTitleP3('COMENTARIOS');
      const comentariosText = U(comentariosTrim);
      const comentariosLines = wrapText(comentariosText, tableWidth - 8, fontRegular, 9);
      comentariosLines.forEach((line) => {
        page3.drawText(line, {
          x: marginX + 4,
          y: cy3 - lineH,
          size: 9,
          font: fontRegular,
          color: rgb(0, 0, 0)
        });
        cy3 -= lineH;
      });
      cy3 -= 14;
    }
  }

  /*
  // ========== EVIDENCIAS FOTOGRÁFICAS (PÁGINA 3) ==========
  // Ajuste para que el checklist de evidencias se vea amplio y entendible, como en tu ejemplo.
  const evidenceLabelsP3 = [
    'Licencia',
    'Evidencia Frontal',
    'Evidencia Lateral 1',
    'Evidencia Lateral 2',
    'Puertas Traseras',
    'Caja abierta'
  ];
  const imageUrlsP3 = registro.image_urls ?? [];
  const colsP3 = 2;
  const rowsP3 = 3;
  const totalCells = colsP3 * rowsP3;

  function drawPlaceholderEvidencia(
    p: PDFPage,
    x: number,
    y: number,
    boxW: number,
    boxH: number,
    font: PDFFont,
    fontSize: number
  ) {
    const text = 'IMAGEN NO DISPONIBLE';
    const tw = font.widthOfTextAtSize(text, fontSize);
    const th = fontSize + 2;
    p.drawText(text, {
      x: x + (boxW - tw) / 2,
      y: y + boxH / 2 - th / 2,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5)
    });
  }

  // Título centrado + línea azul
  const tituloEvidencias = 'EVIDENCIAS FOTOGRÁFICAS';
  const tituloEvW = fontBold.widthOfTextAtSize(tituloEvidencias, 13);
  let cyE = cy3;
  page3.drawText(tituloEvidencias, {
    x: marginX + (tableWidth - tituloEvW) / 2,
    y: cyE,
    size: 13,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  cyE -= 14;

  page3.drawRectangle({
    x: marginX,
    y: cyE - 2,
    width: tableWidth,
    height: 2,
    color: rgb(0, 0.2, 0.6)
  });
  cyE -= 16;

  // Layout fijo (basado en tu código Flutter) para que los cuadros queden centrados.
  // Ajusta solo lo necesario para que se vea como el ejemplo: tamaños consistentes y offsets claros.
  const cellHeight = 160;
  const cellGapX = 10;
  const cellGapY = 12;

  const cellWidth = (tableWidth - cellGapX) / 2;

  // cyE actualmente ya pasó la línea azul; en Flutter, el "y" de inicio de celdas queda ~20px abajo del título.
  // Por eso usamos cyE + 10 para aproximar exactamente ese offset.
  // Desplazamiento vertical del grid completo
  // (si las imágenes quedan muy altas, se reduce este valor para bajarlas).
  // Ajustes solicitados: bajar ~35% y mover ~10% hacia la derecha.
  const verticalShift = cellHeight * 0.35;
  const rightShift = tableWidth * 0.10;
  const yCellsStart = cyE - 30 - verticalShift;

  const imgH = cellHeight - 20;

  for (let i = 0; i < totalCells; i++) {
    const row = Math.floor(i / colsP3);
    const col = i % colsP3;
    const label = evidenceLabelsP3[i] ?? `Evidencia ${i + 1}`;

    const cellX = marginX + rightShift + col * (cellWidth + cellGapX);
    const cellY = yCellsStart - row * (cellHeight + cellGapY); // baseline del label
    const rectY = cellY - cellHeight; // bottom del rectángulo

    // Título dentro de la celda (como Flutter)
    page3.drawText(U(label), {
      x: cellX,
      y: cellY,
      size: 9,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    // Borde de la celda
    page3.drawRectangle({
      x: cellX,
      y: rectY,
      width: cellWidth,
      height: cellHeight,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 0.6
    });

    // Área donde va la imagen (misma lógica que Flutter)
    const url = imageUrlsP3[i];
    const imgY = cellY - imgH - 10; // bottom-left del área de imagen

    if (url) {
      const img = await embedDataUrlImage(pdfDoc, url);
      if (img) {
        // Mejor forma sin deformar:
        // `scaleToFit` preserva el aspect ratio y evita que se salga del cuadro.
        const paddingP3 = 6;
        const innerW = cellWidth - paddingP3 * 2;
        const innerH = imgH - paddingP3 * 2;
        const dims = img.scaleToFit(innerW, innerH);

        const drawX = cellX + paddingP3 + (innerW - dims.width) / 2;
        const drawY = imgY + paddingP3 + (innerH - dims.height) / 2;
        page3.drawImage(img, {
          x: drawX,
          y: drawY,
          width: dims.width,
          height: dims.height
        });
      } else {
        drawPlaceholderEvidencia(page3, cellX, imgY, cellWidth, imgH, fontRegular, 8);
      }
    } else {
      drawPlaceholderEvidencia(page3, cellX, imgY, cellWidth, imgH, fontRegular, 8);
    }
  }

  */

    // Pie página final (solo si la hoja 3 aplica: mecánica habilitada)
    if (mechHabilitadaGlobal) {
      page3.drawText(footerText, {
        x: width / 2 - footerWidth / 2,
        y: 32,
        size: footerSize,
        font: fontRegular,
        color: rgb(0.4, 0.4, 0.4)
      });
    }
  }

  // ========== PÁGINA 4: EVIDENCIAS FOTOGRÁFICAS ==========
  const page4 = pdfDoc.addPage([595.28, 841.89]);
  const height4 = page4.getSize().height;

  if (logoWatermark) {
    const wmDims = logoWatermark.scale(0.5);
    page4.drawImage(logoWatermark, {
      x: width / 2 - wmDims.width / 2,
      y: height4 / 2 - wmDims.height / 2,
      width: wmDims.width,
      height: wmDims.height,
      opacity: 0.05
    });
  }

  const marginP4 = 32;
  let yP4 = height4 - marginP4;

  // Folio en la esquina superior derecha
  if (folioText) {
    page4.drawText(folioText, {
      x: width - 32 - folioWidth,
      y: yP4 - 20,
      size: folioFontSize,
      font: fontBold,
      color: rgb(0, 0.2, 0.6)
    });
  }

  const tituloEvidenciasP4 = 'EVIDENCIAS FOTOGRÁFICAS';
  const tituloEvidenciasW = fontBold.widthOfTextAtSize(tituloEvidenciasP4, 14);
  page4.drawText(U(tituloEvidenciasP4), {
    x: width / 2 - tituloEvidenciasW / 2,
    y: yP4 - 20,
    size: 14,
    font: fontBold,
    color: rgb(0, 0, 0.5)
  });

  // Línea azul debajo del título
  page4.drawRectangle({
    x: marginP4,
    y: yP4 - 24,
    width: width - marginP4 * 2,
    height: 2,
    color: rgb(0, 0.2, 0.6)
  });

  yP4 -= 40;

  const evidenceLabelsP4 = [
    'Licencia',
    'Evidencia Frontal',
    'Evidencia Lateral 1',
    'Evidencia Lateral 2',
    'Puertas Traseras',
    'Evidencia de caja abierta'
  ];

  const imageUrlsP4 = registro.image_urls ?? [];
  const cellWidthP4 = (width - marginP4 * 2 - 16) / 2;
  const cellHeightP4 = 160;
  const cellGapXP4 = 16;
  const cellGapYP4 = 20;

  function drawPlaceholderEvidenciaP4(
    p: PDFPage,
    x: number,
    y: number,
    boxW: number,
    boxH: number,
    font: PDFFont,
    fontSize: number
  ) {
    const text = 'IMAGEN NO DISPONIBLE';
    const tw = font.widthOfTextAtSize(text, fontSize);
    const th = fontSize + 2;
    p.drawText(text, {
      x: x + (boxW - tw) / 2,
      y: y + boxH / 2 - th / 2,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5)
    });
  }

  for (let i = 0; i < evidenceLabelsP4.length; i++) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const cellX = marginP4 + col * (cellWidthP4 + cellGapXP4);
    const cellY = yP4 - row * (cellHeightP4 + cellGapYP4); // baseline del título

    // Título
    page4.drawText(U(evidenceLabelsP4[i]), {
      x: cellX,
      y: cellY,
      size: 9,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    const imgH = cellHeightP4 - 20;
    const imgBoxBottomY = cellY - imgH - 10;

    // Borde de caja (para que se vea similar)
    page4.drawRectangle({
      x: cellX,
      y: imgBoxBottomY,
      width: cellWidthP4,
      height: imgH,
      borderColor: rgb(0.7, 0.7, 0.7),
      borderWidth: 0.7
    });

    const url = imageUrlsP4[i];
    if (url) {
      const img = await embedDataUrlImage(pdfDoc, url);
      if (img) {
        const paddingP4 = 6;
        const innerW = cellWidthP4 - paddingP4 * 2;
        const innerH = imgH - paddingP4 * 2;
        const innerX = cellX + paddingP4;
        const innerY = imgBoxBottomY + paddingP4;
        const orientation = getEvidenceOrientation(registro, i, url);
        drawEvidenceImageWithOrientation(page4, img, orientation, innerX, innerY, innerW, innerH);
      } else {
        drawPlaceholderEvidenciaP4(
          page4,
          cellX + 6,
          imgBoxBottomY + 6,
          cellWidthP4 - 12,
          imgH - 12,
          fontRegular,
          8
        );
      }
    } else {
      drawPlaceholderEvidenciaP4(
        page4,
        cellX + 6,
        imgBoxBottomY + 6,
        cellWidthP4 - 12,
        imgH - 12,
        fontRegular,
        8
      );
    }
  }

  page4.drawText(footerText, {
    x: width / 2 - footerWidth / 2,
    y: 32,
    size: footerSize,
    font: fontRegular,
    color: rgb(0.4, 0.4, 0.4)
  });

  return await pdfDoc.save();
}


function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: corsHeaders(origin)
    });
  }

  if (req.method !== 'POST') {
    return new Response('Método no permitido', {
      status: 405,
      headers: corsHeaders(origin)
    });
  }

  // La Edge Function requiere JWT válido de Supabase.
  // Además, verificamos que el `registroId` pertenece al usuario autenticado.
  const supabaseAuthHeader = req.headers.get('Authorization');
  const currentUserId = decodeJwtSub(supabaseAuthHeader);
  if (!supabaseAuthHeader) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: missing Authorization header' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin)
      }
    });
  }

  if (!currentUserId) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: invalid JWT or missing user id claim' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin)
      }
    });
  }

  let registroIdForCleanup: string | null = null;
  try {
    const { registroId, accessToken } = await req.json();
    registroIdForCleanup = typeof registroId === 'string' ? registroId : null;
    if (!registroId || !accessToken) {
      return new Response('registroId y accessToken son requeridos', {
        status: 400,
        headers: corsHeaders(origin)
      });
    }

    const supabaseServer = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabaseServer
      .from('registros_ctpat')
      .select('*')
      .eq('id', registroId)
      .single<RegistroRow>();

    if (error || !data) {
      return new Response(`Registro no encontrado: ${error?.message ?? 'sin detalle'}`, {
        status: 404,
        headers: corsHeaders(origin)
      });
    }

    // Obtener configuración de Drive por usuario
    if (!data.user_id) {
      return new Response('El registro no tiene user_id asociado', {
        status: 400,
        headers: corsHeaders(origin)
      });
    }

    // Seguridad: solo permitir acciones sobre registros del usuario autenticado.
    if (data.user_id !== currentUserId) {
      return new Response(JSON.stringify({ ok: false, error: 'Forbidden: registro pertenece a otro usuario' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin)
        }
      });
    }

    const { data: authUserRow } = await supabaseServer.auth.admin.getUserById(data.user_id);
    const userMeta = authUserRow?.user?.user_metadata as Record<string, unknown> | undefined;

    const { data: driveCfg, error: driveCfgError } = await supabaseServer
      .from('user_drive_config')
      .select('pdf_folder_id, images_folder_id, service_logo_file')
      .eq('user_id', data.user_id)
      .single<UserDriveConfigRow>();

    // Si no existe config en BD (o está incompleta), creamos la estructura en Drive
    // y persistimos el config con Service Role.
    let finalDriveCfg: UserDriveConfigRow | null = driveCfg ?? null;
    if (driveCfgError || !finalDriveCfg) {
      const { pdfFolderId, imagesFolderId } = await ensureDriveFolders(accessToken);
      const { data: inserted, error: insertErr } = await supabaseServer
        .from('user_drive_config')
        .insert({
          user_id: data.user_id,
          pdf_folder_id: pdfFolderId,
          images_folder_id: imagesFolderId,
          service_logo_file: normalizeServiceLogoFile(logoFromUserMetadata(userMeta))
        })
        .select('pdf_folder_id, images_folder_id, service_logo_file')
        .single<UserDriveConfigRow>();

      if (!insertErr && inserted) {
        finalDriveCfg = inserted;
      } else {
        // Si insert falla (por carrera), aún así intentamos continuar usando los ids creados.
        finalDriveCfg = {
          pdf_folder_id: pdfFolderId,
          images_folder_id: imagesFolderId,
          service_logo_file: null
        };
      }
    }

    // Misma prioridad que la PWA: BD primero; si no hay logo en fila, user_metadata (Auth).
    const resolvedCenterLogo = (() => {
      const d = finalDriveCfg?.service_logo_file?.trim();
      if (d) return d;
      const m = logoFromUserMetadata(userMeta);
      return m ? normalizeServiceLogoFile(m) : null;
    })();

    const pdfBytes = await buildPdf(data, resolvedCenterLogo, supabaseServer);
    const rawFolioFile = (data.folio_pdf ?? '').toString().trim();
    const mFile = rawFolioFile.match(/^TS-0*(\d+)$/i);
    const folioNumFile = mFile ? Number(mFile[1]) : null;
    const folioFile = folioNumFile != null ? `TS-${folioNumFile}` : rawFolioFile || `TS-${data.id}`;
    const fileName = `${folioFile}.pdf`;

    const driveResponse = await uploadToDrive(
      accessToken,
      fileName,
      pdfBytes,
      'application/pdf',
      finalDriveCfg?.pdf_folder_id
    );

    // Subir evidencias como imágenes si vienen embebidas como data URL
    const imageUrls = data.image_urls || [];
    const uploadedImages: { name: string; id: string }[] = [];

    for (let index = 0; index < imageUrls.length; index++) {
      const url = imageUrls[index];
      if (!url || typeof url !== 'string') continue;
      if (!url.startsWith('data:')) continue;

      const match = url.match(/^data:(.+);base64,(.+)$/);
      if (!match) continue;
      const [, mimeType, base64Data] = match;

      const binary = atob(base64Data);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const imageName = `CTPAT_IMG_${data.folio_pdf || data.service_id || data.id}_${index + 1}`;
      try {
        const imgRes = await uploadToDrive(
          accessToken,
          imageName,
          bytes,
          mimeType,
          finalDriveCfg?.images_folder_id
        );
        uploadedImages.push({ name: imageName, id: imgRes.id as string });
      } catch {
        // Si alguna imagen falla no rompemos toda la sincronización
      }
    }

    await supabaseServer
      .from('registros_ctpat')
      .update({ sync_status: 'synced', evidencias_exif: { uploadedImages } })
      .eq('id', data.id)
      .eq('user_id', currentUserId);

    return new Response(JSON.stringify({ ok: true, driveFile: driveResponse }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin)
      }
    });
  } catch (err) {
    console.error(err);

    // Si falló la sincronización, marcamos el registro para que el cleanup pueda manejarlo
    // sin borrar "pending" a destiempo.
    if (registroIdForCleanup) {
      try {
        const supabaseServer = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false }
        });
        await supabaseServer
          .from('registros_ctpat')
          .update({ sync_status: 'error' })
          .eq('id', registroIdForCleanup)
          .eq('user_id', currentUserId);
      } catch {
        // No rompemos el endpoint si falla este marcado.
      }
    }

    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin)
        }
      }
    );
  }
});

