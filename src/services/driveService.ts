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
  return data;
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
