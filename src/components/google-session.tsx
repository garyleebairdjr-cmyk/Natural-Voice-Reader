import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud, CloudOff, FolderOpen, LogIn, LogOut } from "lucide-react";
import { getGooglePublicConfig, isDesktopApp, type GooglePublicConfig } from "@/lib/platform";
import {
  clearGoogleSession,
  fetchProfile,
  readIntroSeen,
  readSaveDownloadsPref,
  readStoredProfile,
  readStoredToken,
  requestAccessToken,
  revokeAccessToken,
  storeProfile,
  tokenIsFresh,
  writeIntroSeen,
  writeSaveDownloadsPref,
  type GoogleProfile,
} from "@/lib/google/auth";
import { loadAppFolders, readDriveText, readSettingsFile, uploadDownloadFile, writeSettingsFile } from "@/lib/google/drive";
import { shouldExplainDriveDownloads, shouldUploadToDrive } from "@/lib/google/opt-in";
import { pickDriveTextFile } from "@/lib/google/picker";
import {
  cloudSettingsEqual,
  mergeCloudSettings,
  serializeCloudSettings,
  type CloudSettings,
} from "@/lib/google/settings";
import type { AppFolders } from "@/lib/google/folders";
import { useLane } from "@/lib/lane-store";

const SYNC_DEBOUNCE_MS = 1500;

type IntroDecision = {
  resolve: (saveToDrive: boolean | "local-only") => void;
};

export type GoogleSessionApi = {
  configured: boolean;
  signedIn: boolean;
  finishDownload: (objectUrl: string, filename: string) => Promise<void>;
};

export function useGoogleSession(): {
  api: GoogleSessionApi;
  accountCard: ReactNode;
  addFromDriveButton: ReactNode;
  dialogs: ReactNode;
  note: string | null;
  error: string | null;
} {
  const [config, setConfig] = useState<GooglePublicConfig | null>(null);
  const [profile, setProfile] = useState<GoogleProfile | null>(() => (typeof window === "undefined" ? null : readStoredProfile()));
  const [folders, setFolders] = useState<AppFolders | null>(null);
  const [saveToDrive, setSaveToDrive] = useState(() => (typeof window === "undefined" ? false : readSaveDownloadsPref()));
  const [introSeen, setIntroSeen] = useState(() => (typeof window === "undefined" ? false : readIntroSeen()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [intro, setIntro] = useState<IntroDecision | null>(null);
  const settingsFileId = useRef<string | null>(null);
  const lastPushed = useRef<string>("");
  const syncTimer = useRef<number | null>(null);
  const applyingRemote = useRef(false);

  const configured = Boolean(config?.enabled && config.clientId && config.apiKey);
  const signedIn = Boolean(profile);

  useEffect(() => {
    let cancelled = false;
    void getGooglePublicConfig().then((next) => {
      if (!cancelled) setConfig(next);
    }).catch(() => {
      if (!cancelled) setConfig({ enabled: false, clientId: "", apiKey: "" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const token = useCallback(async (prompt: "consent" | "" = "") => {
    if (!config?.clientId) throw new Error("Google sign-in is not configured.");
    return requestAccessToken(config.clientId, prompt);
  }, [config?.clientId]);

  const applyCloudSettings = useCallback((settings: CloudSettings) => {
    applyingRemote.current = true;
    const store = useLane.getState();
    store.setTheme(settings.theme);
    store.setInk(settings.ink);
    store.setVoice(settings.voiceId);
    store.setSpeed(settings.speed);
    store.setVolume(settings.volume);
    store.setMuted(settings.muted);
    store.setTtsModel(settings.ttsModel);
    if (typeof settings.settingsOpen === "boolean") store.setSettingsOpen(settings.settingsOpen);
    // Favorites / recents are applied by writing through setVoice and toggle; set state directly if needed.
    useLane.setState({
      favoriteVoiceIds: settings.favoriteVoiceIds,
      recentVoiceIds: settings.recentVoiceIds,
    });
    setSaveToDrive(settings.saveDownloadsToDrive);
    writeSaveDownloadsPref(settings.saveDownloadsToDrive);
    window.setTimeout(() => {
      applyingRemote.current = false;
    }, 0);
  }, []);

  const snapshotSettings = useCallback((): CloudSettings => {
    const state = useLane.getState();
    return serializeCloudSettings({
      theme: state.theme,
      ink: state.ink,
      voiceId: state.voiceId,
      speed: state.speed,
      volume: state.volume,
      muted: state.muted,
      ttsModel: state.ttsModel,
      settingsOpen: state.settingsOpen,
      favoriteVoiceIds: state.favoriteVoiceIds,
      recentVoiceIds: state.recentVoiceIds,
      saveDownloadsToDrive: saveToDrive,
    });
  }, [saveToDrive]);

  const pushSettings = useCallback(async () => {
    if (!profile || !folders || applyingRemote.current) return;
    const local = snapshotSettings();
    const encoded = JSON.stringify(local);
    if (encoded === lastPushed.current) return;
    const access = await token("");
    const file = await writeSettingsFile(access, folders.settings.id, local, settingsFileId.current ?? undefined);
    settingsFileId.current = file.id;
    lastPushed.current = encoded;
  }, [folders, profile, snapshotSettings, token]);

  const schedulePush = useCallback(() => {
    if (!profile || !folders || applyingRemote.current) return;
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      void pushSettings().catch((err) => setError(err instanceof Error ? err.message : "Could not save settings to Google Drive."));
    }, SYNC_DEBOUNCE_MS);
  }, [folders, profile, pushSettings]);

  useEffect(() => {
    if (!profile || !folders) return;
    const unsub = useLane.subscribe(() => schedulePush());
    return () => {
      unsub();
      if (syncTimer.current) window.clearTimeout(syncTimer.current);
    };
  }, [folders, profile, schedulePush]);

  const afterSignIn = useCallback(async (access: string) => {
    const nextProfile = await fetchProfile(access);
    storeProfile(nextProfile);
    setProfile(nextProfile);
    const nextFolders = await loadAppFolders(access);
    setFolders(nextFolders);
    const remote = await readSettingsFile(access, nextFolders.settings.id);
    settingsFileId.current = remote.file?.id ?? null;
    const local = snapshotSettings();
    if (remote.settings) {
      const merged = mergeCloudSettings(local, remote.settings);
      applyCloudSettings(merged);
      lastPushed.current = JSON.stringify(merged);
      if (!cloudSettingsEqual(merged, remote.settings) || !remote.file) {
        const file = await writeSettingsFile(access, nextFolders.settings.id, merged, remote.file?.id);
        settingsFileId.current = file.id;
      }
    } else {
      const file = await writeSettingsFile(access, nextFolders.settings.id, local);
      settingsFileId.current = file.id;
      lastPushed.current = JSON.stringify(local);
    }
  }, [applyCloudSettings, snapshotSettings]);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      const access = await token("consent");
      await afterSignIn(access);
      setNote("Signed in. Settings will sync to the Natural Voice Reader folder in your Google Drive.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in with Google.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await revokeAccessToken();
    } finally {
      clearGoogleSession();
      setProfile(null);
      setFolders(null);
      settingsFileId.current = null;
      lastPushed.current = "";
      setBusy(false);
      setNote("Signed out. Settings on this device stay as they are.");
    }
  }

  useEffect(() => {
    if (!configured || profile) return;
    const stored = readStoredToken();
    const saved = readStoredProfile();
    if (!stored || !tokenIsFresh(stored.expiry) || !saved) return;
    setProfile(saved);
    setBusy(true);
    void afterSignIn(stored.token).catch(() => {
      clearGoogleSession();
      setProfile(null);
    }).finally(() => setBusy(false));
  }, [afterSignIn, configured, profile]);

  function setOptIn(on: boolean) {
    setSaveToDrive(on);
    writeSaveDownloadsPref(on);
    if (on) {
      writeIntroSeen();
      setIntroSeen(true);
    }
    schedulePush();
  }

  async function addFromDrive() {
    if (!config?.apiKey) return;
    setError(null);
    setBusy(true);
    try {
      const access = await token("");
      const picked = await pickDriveTextFile({ token: access, apiKey: config.apiKey });
      if (!picked) return;
      const text = await readDriveText(access, picked.id, picked.name, picked.mimeType);
      if (!text) {
        setError("That file didn't include readable text.");
        return;
      }
      const count = useLane.getState().addPaste(text, "append");
      setNote(count === 1 ? `Added “${picked.name}” as a card.` : `Added “${picked.name}” as ${count} cards.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that Google Drive file.");
    } finally {
      setBusy(false);
    }
  }

  const askIntro = useCallback(() => {
    return new Promise<boolean | "local-only">((resolve) => {
      setIntro({ resolve });
    });
  }, []);

  const finishDownload = useCallback(async (objectUrl: string, filename: string) => {
    const saveLocal = () => {
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    let optedIn = saveToDrive;
    const state = { signedIn, saveToDrive: optedIn, introSeen };
    if (shouldExplainDriveDownloads(state)) {
      const decision = await askIntro();
      writeIntroSeen();
      setIntroSeen(true);
      if (decision === true) {
        optedIn = true;
        setOptIn(true);
      } else if (decision === false) {
        setOptIn(false);
      }
    }
    if (shouldUploadToDrive({ signedIn, saveToDrive: optedIn, introSeen: true })) {
      if (!folders) throw new Error("The Natural Voice Reader folder is not ready yet. Try again in a moment.");
      setProgress(0);
      setNote("Uploading to Google Drive…");
      try {
        const access = await token("");
        const blob = await fetch(objectUrl).then((res) => res.blob());
        await uploadDownloadFile(access, folders.downloads.id, blob, filename, (percent) => setProgress(percent));
        setNote(`Saved ${filename} to Natural Voice Reader/Downloads in Google Drive.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not upload that download to Google Drive.");
        setProgress(null);
        saveLocal();
        return;
      } finally {
        setProgress(null);
      }
    }
    saveLocal();
  }, [askIntro, folders, introSeen, saveToDrive, signedIn, token]);

  const accountCard = (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Google account</h2>
      {!config ? (
        <p className="text-xs leading-relaxed text-muted">Checking Google sign-in…</p>
      ) : !configured && isDesktopApp() ? (
        <p className="text-xs leading-relaxed text-muted">
          Google sign-in is not in the app yet. Your settings and queue are saved on this device.
        </p>
      ) : !configured ? (
        <p className="text-xs leading-relaxed text-muted">
          Sign-in is optional and is not configured on this computer. Add <code className="font-mono">GOOGLE_CLIENT_ID</code> and{" "}
          <code className="font-mono">GOOGLE_API_KEY</code> to <code className="font-mono">.env</code> (see the README), then restart the reader.
        </p>
      ) : signedIn && profile ? (
        <>
          <div className="flex items-center gap-3">
            {profile.picture ? (
              <img src={profile.picture} alt="" className="size-10 rounded-full border border-line" referrerPolicy="no-referrer" />
            ) : (
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-raise text-sm font-semibold text-fg">
                {profile.email.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-fg">{profile.name || profile.email}</p>
              <p className="truncate text-xs text-muted">{profile.email}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={busy}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-3 text-xs font-semibold text-fg disabled:opacity-55"
            >
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </div>
          <label className="flex items-start gap-3 rounded-2xl chip px-3 py-3 text-sm text-fg">
            <input
              type="checkbox"
              className="mt-1"
              checked={saveToDrive}
              onChange={(event) => setOptIn(event.target.checked)}
            />
            <span>
              <span className="flex items-center gap-2 font-semibold">
                {saveToDrive ? <Cloud className="size-4 text-amber" /> : <CloudOff className="size-4 text-muted" />}
                Save downloads to Google Drive
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                Off by default. When this is on, Download also uploads the audio to Natural Voice Reader/Downloads in your Drive. A local file is still saved. You can turn this off at any time.
              </span>
            </span>
          </label>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted">
            Optional. Sign in to sync settings and open text from Google Drive. The app works fully without an account.
          </p>
          <button
            type="button"
            onClick={() => void signIn()}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full chip px-3 text-sm font-semibold text-fg disabled:opacity-55"
          >
            <LogIn className="size-4" />
            Sign in with Google
          </button>
        </div>
      )}
    </section>
  );

  const addFromDriveButton = configured && signedIn ? (
    <button
      type="button"
      onClick={() => void addFromDrive()}
      disabled={busy}
      className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full chip px-4 text-sm font-semibold text-fg disabled:opacity-55"
    >
      <FolderOpen className="size-4" />
      Open from Google Drive
    </button>
  ) : null;

  const dialogs = intro ? (
    <div className="nvr-dialog-root" role="presentation">
      <button type="button" className="nvr-dialog-backdrop" aria-label="Cancel" onClick={() => { intro.resolve("local-only"); setIntro(null); }} />
      <div className="nvr-dialog" role="alertdialog" aria-modal="true" aria-labelledby="nvr-drive-intro-title">
        <h2 id="nvr-drive-intro-title" className="text-base font-semibold text-fg">Save downloads to Google Drive?</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          You can also keep a copy of downloaded audio in <strong className="font-semibold text-fg">Natural Voice Reader/Downloads</strong> in your Google Drive. This is off unless you turn it on. A local file is still saved either way.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="min-h-11 rounded-full border border-line px-4 text-sm font-semibold text-fg" onClick={() => { intro.resolve("local-only"); setIntro(null); }}>
            Just download locally
          </button>
          <button type="button" className="min-h-11 rounded-full border border-line px-4 text-sm font-semibold text-fg" onClick={() => { intro.resolve(false); setIntro(null); }}>
            Don&apos;t save to Drive
          </button>
          <button type="button" className="min-h-11 rounded-full btn-accent px-4 text-sm font-semibold" onClick={() => { intro.resolve(true); setIntro(null); }}>
            Save to Google Drive
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const progressNote = progress != null ? `${note ?? "Uploading to Google Drive…"} (${progress}%)` : note;

  return {
    api: { configured, signedIn, finishDownload },
    accountCard,
    addFromDriveButton,
    dialogs,
    note: progressNote,
    error,
  };
}
