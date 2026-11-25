/**
 * Version and build number of this build, injected by Vite (see vite.config.ts
 * and scripts/build-info.mjs). Falls back to "dev" outside a Vite build.
 */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
declare const __APP_COMMIT__: string;

export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_BUILD = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "0";
export const APP_COMMIT = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "unknown";

/** "Version 0.2.0 (build 27) · a1b2c3d" */
export const APP_VERSION_LABEL = `Version ${APP_VERSION} (build ${APP_BUILD}) · ${APP_COMMIT}`;
