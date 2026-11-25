import assert from "node:assert/strict";
import test from "node:test";
import { VERSION_CODE_BASE, appVersion, buildInfo, tauriConfig } from "./build-info.mjs";

test("the build number is the commit count", () => {
  const info = buildInfo({ env: {}, version: "1.2.3", commitCount: "57", shallow: false, commit: "abc1234" });
  assert.equal(info.build, 57);
  assert.equal(info.versionCode, VERSION_CODE_BASE + 57);
  assert.equal(info.label, "1.2.3 (build 57)");
  assert.equal(info.commit, "abc1234");
});

test("NVR_BUILD_NUMBER overrides the commit count", () => {
  const info = buildInfo({ env: { NVR_BUILD_NUMBER: "301" }, version: "1.0.0", commitCount: "57", commit: "x" });
  assert.equal(info.build, 301);
  assert.equal(info.versionCode, 10301);
});

test("a bad NVR_BUILD_NUMBER is refused", () => {
  for (const bad of ["0", "-3", "12a", "1.5"]) {
    assert.throws(() => buildInfo({ env: { NVR_BUILD_NUMBER: bad }, version: "1.0.0", commit: "x" }), /positive whole number/);
  }
});

test("a shallow clone is refused instead of giving a wrong build number", () => {
  assert.throws(() => buildInfo({ env: {}, version: "1.0.0", shallow: true, commit: "x" }), /shallow/);
});

test("the GitHub commit is used in CI", () => {
  const info = buildInfo({ env: { GITHUB_SHA: "0123456789abcdef" }, version: "1.0.0", commitCount: "3", shallow: false });
  assert.equal(info.commit, "0123456");
});

test("versionCode stays above the 0.2.0 code used before build numbers, and within Play's limit", () => {
  assert.ok(VERSION_CODE_BASE + 1 > 2000);
  assert.ok(VERSION_CODE_BASE + 1_000_000 < 2_100_000_000);
});

test("tauri config carries the Android and macOS build numbers", () => {
  const config = tauriConfig({ version: "1.0.0", build: 42, commit: "x", versionCode: 10042, label: "" });
  assert.deepEqual(config, { bundle: { android: { versionCode: 10042 }, macOS: { bundleVersion: "42" } } });
});

test("the version comes from tauri.conf.json", () => {
  assert.match(appVersion(), /^\d+\.\d+\.\d+/);
});
