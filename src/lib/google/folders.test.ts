import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APP_FOLDER_NAME,
  APP_PROP_DOWNLOADS,
  APP_PROP_KEY,
  APP_PROP_ROOT,
  APP_PROP_SETTINGS,
  DOWNLOADS_FOLDER_NAME,
  SETTINGS_FOLDER_NAME,
  appPropertyQuery,
  ensureAppFolders,
  type DriveFile,
  type DriveFolderClient,
} from "./folders.ts";

function file(id: string, name: string, value: string, parent?: string): DriveFile {
  return { id, name, mimeType: "application/vnd.google-apps.folder", appProperties: { [APP_PROP_KEY]: value }, parents: parent ? [parent] : undefined };
}

function mockClient(existing: DriveFile[] = []) {
  const created: DriveFile[] = [];
  const client: DriveFolderClient = {
    async listFiles(query: string) {
      return [...existing, ...created].filter((item) => {
        const value = item.appProperties?.[APP_PROP_KEY];
        if (query.includes(`value='${APP_PROP_ROOT}'`)) return value === APP_PROP_ROOT;
        if (query.includes(`value='${APP_PROP_SETTINGS}'`)) return value === APP_PROP_SETTINGS;
        if (query.includes(`value='${APP_PROP_DOWNLOADS}'`)) return value === APP_PROP_DOWNLOADS;
        if (query.includes(`name='${APP_FOLDER_NAME}'`)) return item.name === APP_FOLDER_NAME;
        if (query.includes(`name='${SETTINGS_FOLDER_NAME}'`)) return item.name === SETTINGS_FOLDER_NAME;
        if (query.includes(`name='${DOWNLOADS_FOLDER_NAME}'`)) return item.name === DOWNLOADS_FOLDER_NAME;
        return false;
      });
    },
    async createFolder(name, appProperties, parentId) {
      const next = file(`new-${created.length + 1}`, name, appProperties[APP_PROP_KEY] ?? "", parentId);
      created.push(next);
      return next;
    },
  };
  return { client, created };
}

describe("ensureAppFolders", () => {
  it("creates the root and both subfolders once when nothing exists", async () => {
    const { client, created } = mockClient();
    const folders = await ensureAppFolders(client);
    assert.equal(created.length, 3);
    assert.equal(folders.root.name, APP_FOLDER_NAME);
    assert.equal(folders.settings.name, SETTINGS_FOLDER_NAME);
    assert.equal(folders.downloads.name, DOWNLOADS_FOLDER_NAME);
    assert.equal(folders.settings.parents?.[0], folders.root.id);
    assert.equal(folders.downloads.parents?.[0], folders.root.id);
    assert.equal(folders.root.appProperties?.[APP_PROP_KEY], APP_PROP_ROOT);
    const again = await ensureAppFolders(client);
    assert.equal(created.length, 3);
    assert.equal(again.root.id, folders.root.id);
  });

  it("reuses folders found by appProperties and does not create duplicates", async () => {
    const root = file("r1", APP_FOLDER_NAME, APP_PROP_ROOT);
    const settings = file("s1", SETTINGS_FOLDER_NAME, APP_PROP_SETTINGS, "r1");
    const downloads = file("d1", DOWNLOADS_FOLDER_NAME, APP_PROP_DOWNLOADS, "r1");
    const { client, created } = mockClient([root, settings, downloads]);
    const folders = await ensureAppFolders(client);
    assert.equal(created.length, 0);
    assert.equal(folders.root.id, "r1");
    assert.equal(folders.settings.id, "s1");
    assert.equal(folders.downloads.id, "d1");
  });

  it("builds an appProperties query that includes the folder mime type", () => {
    const query = appPropertyQuery(APP_PROP_ROOT);
    assert.match(query, /appProperties has \{ key='nvrFolder' and value='root' \}/);
    assert.match(query, /trashed=false/);
  });
});
