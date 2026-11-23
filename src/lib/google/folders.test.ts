import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APP_FOLDER_NAME,
  APP_PROP_DOWNLOADS,
  APP_PROP_KEY,
  APP_PROP_ROOT,
  APP_PROP_SETTINGS,
  DOWNLOADS_FOLDER_NAME,
  LEGACY_APP_FOLDER_NAMES,
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
  const renamed: string[] = [];
  const client: DriveFolderClient = {
    async listFiles(query: string) {
      return [...existing, ...created].filter((item) => {
        const value = item.appProperties?.[APP_PROP_KEY];
        if (query.includes(`value='${APP_PROP_ROOT}'`)) return value === APP_PROP_ROOT;
        if (query.includes(`value='${APP_PROP_SETTINGS}'`)) return value === APP_PROP_SETTINGS;
        if (query.includes(`value='${APP_PROP_DOWNLOADS}'`)) return value === APP_PROP_DOWNLOADS;
        const named = query.match(/^name='([^']+)'/);
        if (named) return item.name === named[1];
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
    async renameFile(id, name) {
      const target = [...existing, ...created].find((item) => item.id === id);
      if (!target) throw new Error("not found");
      target.name = name;
      renamed.push(id);
      return target;
    },
  };
  return { client, created, renamed };
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

  it("renames a folder that still has the old app name and keeps its contents", async () => {
    const root = file("r1", LEGACY_APP_FOLDER_NAMES[0], APP_PROP_ROOT);
    const settings = file("s1", SETTINGS_FOLDER_NAME, APP_PROP_SETTINGS, "r1");
    const downloads = file("d1", DOWNLOADS_FOLDER_NAME, APP_PROP_DOWNLOADS, "r1");
    const { client, created, renamed } = mockClient([root, settings, downloads]);
    const folders = await ensureAppFolders(client);
    assert.deepEqual(renamed, ["r1"]);
    assert.equal(created.length, 0);
    assert.equal(folders.root.id, "r1");
    assert.equal(folders.root.name, APP_FOLDER_NAME);
    assert.equal(folders.settings.id, "s1");
  });

  it("finds an untagged folder by its old name instead of creating a new one", async () => {
    const root: DriveFile = { id: "r1", name: LEGACY_APP_FOLDER_NAMES[0], mimeType: "application/vnd.google-apps.folder" };
    const { client, created, renamed } = mockClient([root]);
    const folders = await ensureAppFolders(client);
    assert.equal(folders.root.id, "r1");
    assert.deepEqual(renamed, ["r1"]);
    assert.equal(created.filter((item) => item.name === APP_FOLDER_NAME).length, 0);
  });

  it("leaves a folder the user renamed to something else alone", async () => {
    const root = file("r1", "My audio reader", APP_PROP_ROOT);
    const { client, renamed } = mockClient([root]);
    const folders = await ensureAppFolders(client);
    assert.equal(folders.root.id, "r1");
    assert.deepEqual(renamed, []);
  });

  it("builds an appProperties query that includes the folder mime type", () => {
    const query = appPropertyQuery(APP_PROP_ROOT);
    assert.match(query, /appProperties has \{ key='nvrFolder' and value='root' \}/);
    assert.match(query, /trashed=false/);
  });
});
