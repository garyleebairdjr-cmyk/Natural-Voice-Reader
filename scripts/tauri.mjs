#!/usr/bin/env node
/**
 * The Tauri CLI with the build number applied. Use it in place of `tauri`:
 *
 *   node scripts/tauri.mjs build
 *   node scripts/tauri.mjs android build --apk --debug --target aarch64
 *
 * For `build` and `dev` it adds `--config` with the Android versionCode and the
 * macOS bundle version (see scripts/build-info.mjs), and passes the version,
 * build number, and commit to the frontend build through the environment.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildInfo, tauriConfig } from "./build-info.mjs";

const args = process.argv.slice(2);
const info = buildInfo();
const building = args.includes("build") || args.includes("dev");

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

console.log(`Natural Voice Reader ${info.label}, commit ${info.commit}, Android versionCode ${info.versionCode}`);
const result = spawnSync(
  process.execPath,
  [cli, ...args, ...(building ? ["--config", JSON.stringify(tauriConfig(info))] : [])],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NVR_APP_VERSION: info.version,
      NVR_BUILD_NUMBER: String(info.build),
      NVR_BUILD_COMMIT: info.commit,
    },
  },
);
process.exit(result.status ?? 1);
