import { useEffect, useState } from "react";
import { Globe, Loader2, Settings } from "lucide-react";
import { VoicePackBrowseDialog } from "@/components/voice-pack-browse";
import { installVoicePack, isDesktopApp, listVoicePacks, removeVoicePack } from "@/lib/platform";
import { formatPackSize, type VoicePackStatus } from "@/lib/voice-packs";

type Props = {
  packs: VoicePackStatus[];
  onChange: (packs: VoicePackStatus[]) => void;
};

export function VoicePackSettings({ packs, onChange }: Props) {
  const desktop = isDesktopApp();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const installing = packs.some((pack) => pack.installing);

  useEffect(() => {
    if (!installing) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void listVoicePacks()
        .then((result) => {
          if (!cancelled) onChange(result.packs);
        })
        .catch(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [installing, onChange]);

  async function run(id: string, action: "install" | "remove") {
    setError(null);
    setBusyId(id);
    try {
      const result = action === "install"
        ? await installVoicePack({ data: { id } })
        : await removeVoicePack({ data: { id } });
      onChange(result.packs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that voice pack.");
      const latest = await listVoicePacks().catch(() => null);
      if (latest) onChange(latest.packs);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Settings className="size-4 text-muted" />
        <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Settings</h2>
      </div>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">Voice packs</h3>
        {desktop ? null : <button
          type="button"
          onClick={() => setBrowseOpen(true)}
          className="inline-flex min-h-11 items-center gap-2 rounded-full btn-accent px-3 text-xs font-semibold"
        >
          <Globe className="size-4" />
          Browse
        </button>}
      </div>
      {desktop ? (
        <p className="text-xs leading-relaxed text-muted">
          Download voices onto this device. KittenTTS gives the standard voices; Kokoro adds Butler and
          the Indian English voices. Packs installed with <code className="text-fg">nvr voices install</code> on
          this computer are shared with the app.
        </p>
      ) : <p className="text-xs leading-relaxed text-muted">
        Install optional voices onto this computer. Only packs from the catalog, the community
        index, or your
        {" "}
        <code className="text-fg">~/.config/nvr/voices.d</code> overlays can be added. You can also use
        {" "}
        <code className="text-fg">nvr voices install &lt;id&gt;</code>
        {" "}
        or
        {" "}
        <code className="text-fg">nvr voices browse</code>.
      </p>}
      <ul className="flex flex-col gap-2">
        {packs.map((pack) => {
          const busy = busyId === pack.id || pack.installing;
          const percent = pack.progress?.percent;
          return (
            <li key={pack.id} className="glass rounded-2xl px-3.5 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-fg">{pack.name}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{pack.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-line px-2 py-0.5 font-semibold text-fg">
                      {formatPackSize(pack.sizeBytes)}
                    </span>
                    <span className="rounded-full border border-line px-2 py-0.5 font-semibold text-fg">
                      {pack.license}
                    </span>
                    {!pack.commercialUse ? (
                      <span className="rounded-full border border-amber bg-raise px-2 py-0.5 font-semibold text-amber">
                        Not for commercial use
                      </span>
                    ) : null}
                    {pack.installByDefault ? (
                      <span className="rounded-full border border-line px-2 py-0.5 text-muted">Default</span>
                    ) : null}
                    <span className="text-muted">{pack.installed ? "Installed" : "Not installed"}</span>
                  </div>
                  {pack.licenseNote ? <p className="mt-2 text-xs leading-relaxed text-muted">{pack.licenseNote}</p> : null}
                  {pack.progress?.state === "error" && !pack.installing ? (
                    <p className="mt-2 text-xs text-fg" role="alert">
                      {pack.progress.message}
                    </p>
                  ) : null}
                  {pack.progress && pack.installing ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <p className="text-xs text-fg" role="status">
                        {pack.progress.message}
                        {percent != null ? ` (${Math.round(percent)}%)` : ""}
                      </p>
                      <div className="nvr-progress" aria-hidden="true" style={{ height: 4 }}>
                        <span style={{ width: `${Math.max(3, Math.round(percent ?? 0))}%` }} />
                      </div>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(pack.id, pack.installed && !pack.installing ? "remove" : "install")}
                  className={
                    "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border px-3 text-xs font-semibold disabled:opacity-40 " +
                    (pack.installed
                      ? "border-line bg-surface/60 text-muted hover:text-danger"
                      : "btn-accent border-transparent")
                  }
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : pack.installed ? "Remove" : "Install"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <VoicePackBrowseDialog open={browseOpen} onClose={() => setBrowseOpen(false)} onInstalled={onChange} />
    </section>
  );
}
