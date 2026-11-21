import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldExplainDriveDownloads, shouldUploadToDrive } from "./opt-in.ts";

describe("Drive download opt-in", () => {
  it("does not upload unless the user is signed in and accepted the toggle", () => {
    assert.equal(shouldUploadToDrive({ signedIn: false, saveToDrive: true, introSeen: true }), false);
    assert.equal(shouldUploadToDrive({ signedIn: true, saveToDrive: false, introSeen: true }), false);
    assert.equal(shouldUploadToDrive({ signedIn: true, saveToDrive: true, introSeen: false }), true);
    assert.equal(shouldUploadToDrive({ signedIn: true, saveToDrive: true, introSeen: true }), true);
  });

  it("explains the option the first time a signed-in user downloads", () => {
    assert.equal(shouldExplainDriveDownloads({ signedIn: false, saveToDrive: false, introSeen: false }), false);
    assert.equal(shouldExplainDriveDownloads({ signedIn: true, saveToDrive: false, introSeen: false }), true);
    assert.equal(shouldExplainDriveDownloads({ signedIn: true, saveToDrive: false, introSeen: true }), false);
  });
});
