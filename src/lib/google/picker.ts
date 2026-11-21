import { isReadableDriveType } from "./drive.ts";
import "./gis.ts";
import type { PickerData, PickerDoc } from "./gis.ts";

export type PickedDriveFile = {
  id: string;
  name: string;
  mimeType?: string;
};

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Could not load ${src}.`)));
      // already loaded
      if ((src.includes("api.js") && window.gapi) || (src.includes("gsi") && window.google)) resolve();
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}.`));
    document.head.appendChild(script);
  });
}

export async function loadGooglePicker(): Promise<void> {
  if (window.google?.picker) return;
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi?.load) {
      reject(new Error("Google API loader is not available."));
      return;
    }
    window.gapi.load("picker", () => resolve());
  });
}

export async function pickDriveTextFile(opts: { token: string; apiKey: string }): Promise<PickedDriveFile | null> {
  await loadGooglePicker();
  const pickerApi = window.google?.picker;
  if (!pickerApi) throw new Error("Google Picker is not available.");
  return new Promise((resolve, reject) => {
    try {
      const view = new pickerApi.DocsView(pickerApi.ViewId?.DOCS);
      view.setIncludeFolders?.(true);
      view.setMimeTypes?.(
        "application/vnd.google-apps.document,text/plain,text/markdown,text/x-markdown,application/json",
      );
      const builder = new pickerApi.PickerBuilder()
        .addView(view)
        .setOAuthToken(opts.token)
        .setDeveloperKey(opts.apiKey)
        .setCallback((data) => {
          const action = data.action;
          if (action === pickerApi.Action?.CANCEL || action === "cancel") {
            resolve(null);
            return;
          }
          if (action === pickerApi.Action?.PICKED || action === "picked") {
            const doc = data.docs?.[0];
            if (!doc || typeof (doc as PickerDoc).id !== "string") {
              resolve(null);
              return;
            }
            const file: PickedDriveFile = {
              id: (doc as PickerDoc).id!,
              name: typeof (doc as PickerDoc).name === "string" ? (doc as PickerDoc).name! : "Untitled",
              mimeType: typeof (doc as PickerDoc).mimeType === "string" ? (doc as PickerDoc).mimeType : undefined,
            };
            if (!isReadableDriveType(file.name, file.mimeType)) {
              reject(new Error("That file type is not supported. Choose a Google Doc, a .txt file, or a Markdown file."));
              return;
            }
            resolve(file);
          }
        });
      const withOrigin = builder as { setOrigin?: (origin: string) => unknown; setTitle?: (title: string) => unknown };
      withOrigin.setOrigin?.(window.location.origin);
      withOrigin.setTitle?.("Choose a text file");
      builder.build().setVisible(true);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Could not open Google Picker."));
    }
  });
}
