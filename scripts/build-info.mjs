#!/usr/bin/env node
/**
 * One source for the app's version and build number.
 *
 * - version: `version` in src-tauri/tauri.conf.json (bump it by hand for releases).
 * - build:   the number of commits in HEAD's history, so the same commit gets the
 *            same build number locally and in CI, and every new commit counts up.
 *            Set NVR_BUILD_NUMBER to override it (a positive whole number).
 *
 * Derived values:
 * - Android versionCode = 10000 + build. Android only installs an update over an
 *   older versionCode; the offset keeps it above the 2000 that 0.2.0 used before
 *   build numbers existed.
 * - macOS CFBundleVersion = build.
 *
 * CLI:
 *   node scripts/build-info.mjs                 print the info as JSON
 *   node scripts/build-info.mjs --github-output also append it to $GITHUB_OUTPUT
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION_CODE_BASE = 10000;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** @returns {string} */
export function appVersion() {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  return String(conf.version);
}

/**
 * @param {{ env?: Record<string, string | undefined>, version?: string, commitCount?: string, shallow?: boolean, commit?: string }} [input]
 *   Test hooks; by default reads the environment, tauri.conf.json, and git.
 */
export function buildInfo(input = {}) {
  const env = input.env ?? process.env;
  const version = input.version ?? appVersion();
  const override = env.NVR_BUILD_NUMBER?.trim();

  let build;
  if (override) {
    if (!/^[1-9]\d*$/.test(override)) {
      throw new Error(`NVR_BUILD_NUMBER must be a positive whole number, not "${override}".`);
    }
    build = Number(override);
  } else {
    const shallow = input.shallow ?? git(["rev-parse", "--is-shallow-repository"]) === "true";
    if (shallow) {
      throw new Error(
        "This is a shallow git clone, so the commit count is wrong. Fetch full history " +
          "(actions/checkout with fetch-depth: 0) or set NVR_BUILD_NUMBER.",
      );
    }
    const count = input.commitCount ?? git(["rev-list", "--count", "HEAD"]);
    build = /^\d+$/.test(count) ? Number(count) : 0;
  }

  const commit = input.commit ?? (env.GITHUB_SHA?.slice(0, 7) || git(["rev-parse", "--short", "HEAD"]) || "unknown");
  return {
    version,
    build,
    commit,
    versionCode: VERSION_CODE_BASE + build,
    label: `${version} (build ${build})`,
  };
}

/** Config merged into tauri.conf.json at build time (`tauri … --config <json>`). */
export function tauriConfig(info) {
  return {
    bundle: {
      android: { versionCode: info.versionCode },
      macOS: { bundleVersion: String(info.build) },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const info = buildInfo();
  console.log(JSON.stringify(info, null, 2));
  if (process.argv.includes("--github-output")) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error("--github-output needs GITHUB_OUTPUT (run it inside GitHub Actions).");
    appendFileSync(
      out,
      Object.entries(info)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
}
