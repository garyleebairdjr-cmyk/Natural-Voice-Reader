import {
  APP_PROP_KEY,
  APP_PROP_SETTINGS_FILE,
  SETTINGS_FILE_NAME,
  ensureAppFolders,
  type AppFolders,
  type DriveFile,
  type DriveFolderClient,
} from "./folders.ts";
import { parseCloudSettings, serializeCloudSettings, type CloudSettings } from "./settings.ts";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

export type AccessToken = string;

function authHeaders(token: AccessToken, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function driveJson<T>(token: AccessToken, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(token, init?.headers) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(sanitizeDriveError(`Google Drive request failed (${res.status}). ${text}`));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function sanitizeDriveError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/ya29\.[A-Za-z0-9._~+/=-]+/g, "[redacted]")
    .slice(0, 400);
}

export function createDriveFolderClient(token: AccessToken): DriveFolderClient {
  return {
    async listFiles(query: string) {
      const url = new URL(`${DRIVE}/files`);
      url.searchParams.set("q", query);
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("fields", "files(id,name,mimeType,appProperties,parents)");
      url.searchParams.set("pageSize", "10");
      const body = await driveJson<{ files?: DriveFile[] }>(token, url.toString());
      return body.files ?? [];
    },
    async createFolder(name, appProperties, parentId) {
      return driveJson<DriveFile>(token, `${DRIVE}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: parentId ? [parentId] : undefined,
          appProperties,
        }),
      });
    },
    async renameFile(id, name) {
      return driveJson<DriveFile>(token, `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,appProperties,parents`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
  };
}

export async function loadAppFolders(token: AccessToken): Promise<AppFolders> {
  return ensureAppFolders(createDriveFolderClient(token));
}

export async function readSettingsFile(token: AccessToken, settingsFolderId: string): Promise<{ file: DriveFile | null; settings: CloudSettings | null }> {
  const url = new URL(`${DRIVE}/files`);
  url.searchParams.set(
    "q",
    `'${settingsFolderId}' in parents and name='${SETTINGS_FILE_NAME}' and trashed=false`,
  );
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime)");
  const listed = await driveJson<{ files?: DriveFile[] }>(token, url.toString());
  const file = listed.files?.[0] ?? null;
  if (!file) return { file: null, settings: null };
  const res = await fetch(`${DRIVE}/files/${encodeURIComponent(file.id)}?alt=media`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(sanitizeDriveError(`Could not read settings.json (${res.status}).`));
  const raw = await res.json().catch(() => null);
  return { file, settings: parseCloudSettings(raw) };
}

export async function writeSettingsFile(
  token: AccessToken,
  settingsFolderId: string,
  settings: CloudSettings,
  existingId?: string,
): Promise<DriveFile> {
  const body = JSON.stringify(serializeCloudSettings(settings), null, 2);
  const media = new Blob([body], { type: "application/json" });
  if (existingId) {
    const res = await fetch(`${UPLOAD}/files/${encodeURIComponent(existingId)}?uploadType=media`, {
      method: "PATCH",
      headers: authHeaders(token, { "Content-Type": "application/json" }),
      body: media,
    });
    if (!res.ok) throw new Error(sanitizeDriveError(`Could not update settings.json (${res.status}).`));
    return (await res.json()) as DriveFile;
  }
  const meta = {
    name: SETTINGS_FILE_NAME,
    mimeType: "application/json",
    parents: [settingsFolderId],
    appProperties: { [APP_PROP_KEY]: APP_PROP_SETTINGS_FILE },
  };
  return uploadMultipart(token, meta, media, "application/json");
}

async function uploadMultipart(token: AccessToken, metadata: object, media: Blob, mime: string): Promise<DriveFile> {
  const boundary = `nvr_${Math.random().toString(16).slice(2)}`;
  const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--`;
  const body = new Blob([prefix, media, suffix], { type: `multipart/related; boundary=${boundary}` });
  const res = await fetch(`${UPLOAD}/files?uploadType=multipart`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": `multipart/related; boundary=${boundary}` }),
    body,
  });
  if (!res.ok) throw new Error(sanitizeDriveError(`Could not upload to Google Drive (${res.status}).`));
  return (await res.json()) as DriveFile;
}

export type UploadProgress = (percent: number | null) => void;

export async function uploadDownloadFile(
  token: AccessToken,
  downloadsFolderId: string,
  file: Blob,
  name: string,
  onProgress?: UploadProgress,
): Promise<DriveFile> {
  const mime = file.type || "audio/mpeg";
  const metadata = { name, parents: [downloadsFolderId], mimeType: mime };
  if (file.size <= MULTIPART_THRESHOLD) {
    onProgress?.(100);
    return uploadMultipart(token, metadata, file, mime);
  }
  return uploadResumable(token, metadata, file, mime, onProgress);
}

function uploadResumable(
  token: AccessToken,
  metadata: object,
  file: Blob,
  mime: string,
  onProgress?: UploadProgress,
): Promise<DriveFile> {
  return new Promise((resolve, reject) => {
    const start = new XMLHttpRequest();
    start.open("POST", `${UPLOAD}/files?uploadType=resumable`);
    start.setRequestHeader("Authorization", `Bearer ${token}`);
    start.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
    start.setRequestHeader("X-Upload-Content-Type", mime);
    start.setRequestHeader("X-Upload-Content-Length", String(file.size));
    start.onerror = () => reject(new Error("Could not start a Google Drive upload."));
    start.onload = () => {
      if (start.status < 200 || start.status >= 300) {
        reject(new Error(sanitizeDriveError(`Could not start a Google Drive upload (${start.status}).`)));
        return;
      }
      const session = start.getResponseHeader("Location");
      if (!session) {
        reject(new Error("Google Drive did not return an upload session."));
        return;
      }
      const put = new XMLHttpRequest();
      put.open("PUT", session);
      put.setRequestHeader("Content-Type", mime);
      put.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
        else onProgress?.(null);
      };
      put.onerror = () => reject(new Error("The Google Drive upload was interrupted."));
      put.onload = () => {
        if (put.status < 200 || put.status >= 300) {
          reject(new Error(sanitizeDriveError(`Could not finish the Google Drive upload (${put.status}).`)));
          return;
        }
        try {
          resolve(JSON.parse(put.responseText) as DriveFile);
        } catch {
          reject(new Error("Google Drive returned an unexpected upload response."));
        }
      };
      put.send(file);
    };
    start.send(JSON.stringify(metadata));
  });
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/md",
  "application/json",
]);

export function isReadableDriveType(name: string, mimeType?: string): boolean {
  const lower = name.toLowerCase();
  if (mimeType === GOOGLE_DOC) return true;
  if (mimeType && TEXT_TYPES.has(mimeType)) return true;
  return lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".markdown");
}

export async function readDriveText(token: AccessToken, fileId: string, name: string, mimeType?: string): Promise<string> {
  if (!isReadableDriveType(name, mimeType)) {
    throw new Error("That file type is not supported. Choose a Google Doc, a .txt file, or a Markdown file.");
  }
  if (mimeType === GOOGLE_DOC) {
    const res = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/plain")}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) throw new Error(sanitizeDriveError(`Could not export that Google Doc (${res.status}).`));
    return (await res.text()).trim();
  }
  const res = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(sanitizeDriveError(`Could not download that file (${res.status}).`));
  return (await res.text()).trim();
}
