export const APP_FOLDER_NAME = "Natural Voice Reader";
/** Earlier names of the app folder. A folder still using one is renamed in place. */
export const LEGACY_APP_FOLDER_NAMES = ["Natural Text Reader"] as const;
export const SETTINGS_FOLDER_NAME = "Settings";
export const DOWNLOADS_FOLDER_NAME = "Downloads";
export const SETTINGS_FILE_NAME = "settings.json";

export const APP_PROP_KEY = "nvrFolder";
export const APP_PROP_ROOT = "root";
export const APP_PROP_SETTINGS = "settings";
export const APP_PROP_DOWNLOADS = "downloads";
export const APP_PROP_SETTINGS_FILE = "settings-file";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
  parents?: string[];
};

export type DriveFolderClient = {
  listFiles(query: string): Promise<DriveFile[]>;
  createFolder(name: string, appProperties: Record<string, string>, parentId?: string): Promise<DriveFile>;
  renameFile?(id: string, name: string): Promise<DriveFile>;
};

export type AppFolders = {
  root: DriveFile;
  settings: DriveFile;
  downloads: DriveFile;
};

export function appPropertyQuery(value: string, parentId?: string): string {
  const props = `appProperties has { key='${APP_PROP_KEY}' and value='${value}' }`;
  const folder = `mimeType='${FOLDER_MIME}'`;
  const trash = "trashed=false";
  const parent = parentId ? ` and '${parentId}' in parents` : "";
  return `${props} and ${folder} and ${trash}${parent}`;
}

export function folderNameQuery(name: string, parentId?: string): string {
  const escaped = name.replaceAll("'", "\\'");
  const parent = parentId ? ` and '${parentId}' in parents` : "";
  return `name='${escaped}' and mimeType='${FOLDER_MIME}' and trashed=false${parent}`;
}

function pickFolder(files: DriveFile[], name: string, value: string): DriveFile | undefined {
  return (
    files.find((file) => file.appProperties?.[APP_PROP_KEY] === value) ||
    files.find((file) => file.name === name && file.mimeType === FOLDER_MIME) ||
    files[0]
  );
}

async function findOrCreateFolder(
  client: DriveFolderClient,
  name: string,
  value: string,
  parentId?: string,
): Promise<DriveFile> {
  const byProp = await client.listFiles(appPropertyQuery(value, parentId));
  const existing = pickFolder(byProp, name, value);
  if (existing) return existing;
  const byName = await client.listFiles(folderNameQuery(name, parentId));
  const named = pickFolder(byName, name, value);
  if (named) return named;
  return client.createFolder(name, { [APP_PROP_KEY]: value }, parentId);
}

/** Rename a root folder that still has an old app name. A name the user chose is left alone. */
async function renameLegacyRoot(client: DriveFolderClient, root: DriveFile): Promise<DriveFile> {
  if (root.name === APP_FOLDER_NAME || !(LEGACY_APP_FOLDER_NAMES as readonly string[]).includes(root.name)) return root;
  if (!client.renameFile) return root;
  try {
    const renamed = await client.renameFile(root.id, APP_FOLDER_NAME);
    return { ...root, ...renamed, name: renamed?.name ?? APP_FOLDER_NAME };
  } catch {
    // Keep using the folder under its old name; the rename can happen next sign-in.
    return root;
  }
}

async function findRootFolder(client: DriveFolderClient): Promise<DriveFile> {
  const byProp = await client.listFiles(appPropertyQuery(APP_PROP_ROOT));
  const tagged = pickFolder(byProp, APP_FOLDER_NAME, APP_PROP_ROOT);
  if (tagged) return tagged;
  for (const name of [APP_FOLDER_NAME, ...LEGACY_APP_FOLDER_NAMES]) {
    const named = pickFolder(await client.listFiles(folderNameQuery(name)), name, APP_PROP_ROOT);
    if (named) return named;
  }
  return client.createFolder(APP_FOLDER_NAME, { [APP_PROP_KEY]: APP_PROP_ROOT });
}

/** Find or create Natural Voice Reader / Settings / Downloads without duplicates. */
export async function ensureAppFolders(client: DriveFolderClient): Promise<AppFolders> {
  const root = await renameLegacyRoot(client, await findRootFolder(client));
  const settings = await findOrCreateFolder(client, SETTINGS_FOLDER_NAME, APP_PROP_SETTINGS, root.id);
  const downloads = await findOrCreateFolder(client, DOWNLOADS_FOLDER_NAME, APP_PROP_DOWNLOADS, root.id);
  return { root, settings, downloads };
}
