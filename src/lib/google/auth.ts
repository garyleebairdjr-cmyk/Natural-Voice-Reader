import "./gis.ts";
import type { GisTokenResponse } from "./gis.ts";

export const GOOGLE_SCOPES = "openid email profile https://www.googleapis.com/auth/drive.file";
const TOKEN_KEY = "nvr.google.accessToken";
const EXPIRY_KEY = "nvr.google.tokenExpiry";
const PROFILE_KEY = "nvr.google.profile";
const INTRO_KEY = "nvr.google.driveDownloadIntroSeen";
const SAVE_KEY = "nvr.google.saveDownloadsToDrive";

export type GoogleProfile = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
};


function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredToken(): { token: string; expiry: number } | null {
  const store = storage();
  const token = store?.getItem(TOKEN_KEY)?.trim();
  const expiry = Number(store?.getItem(EXPIRY_KEY) || 0);
  if (!token) return null;
  return { token, expiry };
}

export function storeToken(token: string, expiresIn: number): void {
  const store = storage();
  store?.setItem(TOKEN_KEY, token);
  store?.setItem(EXPIRY_KEY, String(Date.now() + Math.max(30, expiresIn) * 1000));
}

export function readStoredProfile(): GoogleProfile | null {
  const raw = storage()?.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GoogleProfile;
    if (typeof parsed.email === "string" && typeof parsed.sub === "string") return parsed;
  } catch {
    return null;
  }
  return null;
}

export function storeProfile(profile: GoogleProfile): void {
  storage()?.setItem(PROFILE_KEY, JSON.stringify({ sub: profile.sub, email: profile.email, name: profile.name, picture: profile.picture }));
}

export function clearGoogleSession(): void {
  const store = storage();
  store?.removeItem(TOKEN_KEY);
  store?.removeItem(EXPIRY_KEY);
  store?.removeItem(PROFILE_KEY);
}

export function readIntroSeen(): boolean {
  return local()?.getItem(INTRO_KEY) === "1";
}

export function writeIntroSeen(): void {
  local()?.setItem(INTRO_KEY, "1");
}

export function readSaveDownloadsPref(): boolean {
  return local()?.getItem(SAVE_KEY) === "1";
}

export function writeSaveDownloadsPref(on: boolean): void {
  const store = local();
  if (!store) return;
  if (on) store.setItem(SAVE_KEY, "1");
  else store.removeItem(SAVE_KEY);
}

export function tokenIsFresh(expiry: number, skewMs = 60_000): boolean {
  return expiry - skewMs > Date.now();
}

export function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Could not load Google Identity Services.")));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google Identity Services."));
    document.head.appendChild(script);
  });
}

export async function fetchProfile(token: string): Promise<GoogleProfile> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read the Google account (${res.status}).`);
  const raw = (await res.json()) as { sub?: unknown; email?: unknown; name?: unknown; picture?: unknown };
  if (typeof raw.sub !== "string" || typeof raw.email !== "string") {
    throw new Error("Google did not return an email for this account.");
  }
  return {
    sub: raw.sub,
    email: raw.email,
    name: typeof raw.name === "string" ? raw.name : undefined,
    picture: typeof raw.picture === "string" ? raw.picture : undefined,
  };
}

export async function requestAccessToken(clientId: string, prompt: "consent" | "" = ""): Promise<string> {
  const existing = readStoredToken();
  if (existing && tokenIsFresh(existing.expiry) && !prompt) return existing.token;
  await loadGisScript();
  const oauth = window.google?.accounts?.oauth2;
  if (!oauth) throw new Error("Google Identity Services is not available.");
  const token = await new Promise<string>((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SCOPES,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || "Google sign-in was cancelled."));
          return;
        }
        storeToken(response.access_token, Number(response.expires_in) || 3600);
        resolve(response.access_token);
      },
      error_callback: (error) => {
        reject(new Error(error.message || "Google sign-in was cancelled."));
      },
    });
    client.requestAccessToken({ prompt });
  });
  return token;
}

export async function revokeAccessToken(): Promise<void> {
  const existing = readStoredToken();
  const token = existing?.token;
  clearGoogleSession();
  if (!token) return;
  try {
    await loadGisScript();
    await new Promise<void>((resolve) => {
      const oauth = window.google?.accounts?.oauth2;
      if (!oauth) {
        resolve();
        return;
      }
      oauth.revoke(token, () => resolve());
      setTimeout(resolve, 2000);
    });
  } catch {
    // Local state is already cleared.
  }
}
