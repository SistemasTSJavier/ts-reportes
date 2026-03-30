/**
 * Crea carpetas en Google Drive del usuario.
 * Se usa tras iniciar sesión con Google para tener PDFs y evidencias organizados.
 */

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const ROOT_FOLDER_NAME = 'TS REPORTES';
const PDF_FOLDER_NAME = 'PDFs';
const IMAGES_FOLDER_NAME = 'Evidencias';

export interface DriveFolders {
  pdfFolderId: string;
  imagesFolderId: string;
}

const DRIVE_RETRY_MAX = 3;
const DRIVE_RETRY_BASE_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function driveRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

/**
 * Crea una carpeta en Drive (raíz o dentro de parentId).
 */
async function createFolder(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) {
    body.parents = [parentId];
  } else {
    body.parents = ['root'];
  }

  let lastErr = '';
  for (let attempt = 0; attempt < DRIVE_RETRY_MAX; attempt++) {
    const res = await fetch(DRIVE_FILES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      return (await res.json()) as { id: string };
    }

    const text = await res.text();
    lastErr = text;
    if (res.status === 401) {
      throw new Error(
        'El acceso a Google Drive expiró o el token no es válido. Vuelve a iniciar sesión con Google en la app y acepta los permisos de Drive.'
      );
    }
    if (res.status === 403) {
      throw new Error(
        'Google Drive rechazó la operación (permisos). Revisa la cuenta o vuelve a conectar la app con Google.'
      );
    }
    if (!driveRetryable(res.status) || attempt === DRIVE_RETRY_MAX - 1) {
      throw new Error(`Error creando carpeta "${name}" en Drive: ${text}`);
    }
    await sleep(DRIVE_RETRY_BASE_MS * Math.pow(2, attempt));
  }
  throw new Error(`Error creando carpeta "${name}" en Drive: ${lastErr}`);
}

/**
 * Crea la estructura: carpeta general "TS REPORTES" y dentro "PDFs" y "Evidencias".
 * Pide autorización a Google (scope drive o drive.file) para crear carpetas.
 */
export async function ensureDriveFolders(accessToken: string): Promise<DriveFolders> {
  const root = await createFolder(accessToken, ROOT_FOLDER_NAME, undefined);
  const [pdf, images] = await Promise.all([
    createFolder(accessToken, PDF_FOLDER_NAME, root.id),
    createFolder(accessToken, IMAGES_FOLDER_NAME, root.id)
  ]);

  return {
    pdfFolderId: pdf.id,
    imagesFolderId: images.id
  };
}
