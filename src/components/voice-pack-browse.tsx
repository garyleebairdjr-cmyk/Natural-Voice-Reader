import { useEffect, useMemo, useState } from "react";
import { Globe, Loader2, Plus, X } from "lucide-react";
import {
  addCatalogIndex,
  browseVoicePacks,
  installCommunityPack,
  removeCatalogIndex,
  type CommunityBrowseResult,
} from "@/lib/platform";
import { formatPackSize, type CommunityBrowsePack, type VoicePackStatus } from "@/lib/voice-packs";

type Props = {
  open: boolean;
  onClose: () => void;
  onInstalled: (packs: VoicePackStatus[]) => void;
};

export function VoicePackBrowseDialog({ open, onClose, onInstalled }: Props) {
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("");
  const [gender, setGender] = useState<"" | "male" | "female" | "neutral">("");
  const [license, setLicense] = useState("");
  const [commercialOnly, setCommercialOnly] = useState(false);
  const [result, setResult] = useState<CommunityBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<CommunityBrowsePack | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState("");
  const [showAddUrl, setShowAddUrl] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void browseVoicePacks({
      data: {
        query,
        language,
        gender: gender || undefined,
        license,
        commercialUse: commercialOnly ? true : undefined,
      },
    })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the community catalog.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, query, language, gender, license, commercialOnly]);

  const licenses = useMemo(() => {
    const values = new Set((result?.packs ?? []).map((pack) => pack.license));
    return [...values].sort();
  }, [result]);
  const languages = useMemo(() => {
    const values = new Set((result?.packs ?? []).flatMap((pack) => pack.voices.map((voice: { language: string }) => voice.language)));
    return [...values].sort();
  }, [result]);

  if (!open) return null;

  async function confirmInstall() {
    if (!pending) return;
    setBusyId(pending.id);
    setError(null);
    try {
      const installed = await installCommunityPack({ data: { id: pending.id } });
      onInstalled(installed.packs);
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install that pack.");
    } finally {
      setBusyId(null);
    }
  }

  async function addUrl() {
    const url = newUrl.trim();
    if (!url) return;
    setError(null);
    try {
      const listed = await addCatalogIndex({ data: { url } });
      setNewUrl("");
      setShowAddUrl(false);
      setResult((current) => (current ? { ...current, urls: listed.urls } : current));
      const next = await browseVoicePacks({ data: { query, language, gender: gender || undefined, license, commercialUse: commercialOnly ? true : undefined } });
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that catalog URL.");
    }
  }

  async function dropUrl(url: string) {
    try {
      const listed = await removeCatalogIndex({ data: { url } });
      const next = await browseVoicePacks({ data: { query, language, gender: gender || undefined, license, commercialUse: commercialOnly ? true : undefined } });
      setResult({ ...next, urls: listed.urls });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that catalog URL.");
    }
  }

  return (
    <div className="nvr-dialog-root" role="presentation">
      <button type="button" className="nvr-dialog-backdrop" aria-label="Close browse dialog" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nvr-browse-title"
        className="nvr-dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="nvr-browse-title" className="text-base font-semibold text-fg">
              Browse voice packs
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Packs come from a validated community catalog. The browser never sends a download URL; only a pack id is installed after you confirm.
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-full text-muted">
            <X className="size-5" />
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search packs, languages, or licenses"
            className="min-h-11 w-full rounded-xl border border-line bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-amber"
          />
          <div className="flex flex-wrap gap-2">
            <select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Language" className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs font-semibold text-fg">
              <option value="">All languages</option>
              {languages.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <select value={gender} onChange={(event) => setGender(event.target.value as typeof gender)} aria-label="Gender" className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs font-semibold text-fg">
              <option value="">All genders</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="neutral">Neutral</option>
            </select>
            <select value={license} onChange={(event) => setLicense(event.target.value)} aria-label="License" className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs font-semibold text-fg">
              <option value="">All licenses</option>
              {licenses.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={commercialOnly}
              onClick={() => setCommercialOnly((value) => !value)}
              className={"min-h-11 rounded-full border px-3 text-xs font-semibold " + (commercialOnly ? "border-amber bg-raise text-amber" : "border-line bg-surface text-muted")}
            >
              Commercial use only
            </button>
          </div>
        </div>
        <div className="mt-4 min-h-40 max-h-[50vh] overflow-y-auto">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading the community catalog…</p>
          ) : result?.packs.length ? (
            <ul className="flex flex-col gap-2">
              {result.packs.map((pack) => (
                <li key={pack.id} className="rounded-2xl border border-line bg-bg px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-fg">{pack.name}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{pack.description}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full border border-line px-2 py-0.5 font-semibold">{formatPackSize(pack.sizeBytes)}</span>
                        <span className="rounded-full border border-line px-2 py-0.5 font-semibold">{pack.license}</span>
                        {!pack.commercialUse ? (
                          <span className="rounded-full border border-amber bg-raise px-2 py-0.5 font-semibold text-amber">Not for commercial use</span>
                        ) : null}
                        <span className="text-muted">{pack.installed ? "Installed" : pack.inLibrary ? "In library" : "Available"}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={pack.installed || busyId === pack.id}
                      onClick={() => setPending(pack)}
                      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-amber bg-amber px-3 text-xs font-semibold text-ink disabled:opacity-40"
                    >
                      {pack.installed ? "Installed" : "Install"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No community packs matched those filters.</p>
          )}
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <button type="button" onClick={() => setShowAddUrl((value) => !value)} className="inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-muted">
            <Plus className="size-4" /> Add catalog URL
          </button>
          {showAddUrl ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs leading-relaxed text-amber">
                Advanced: only add a catalog you trust. The index is fetched on this computer, must be https on an allowed host, and every pack still needs checksums. A malicious index will be rejected if it points at a disallowed host or omits sha256 values.
              </p>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={newUrl}
                  onChange={(event) => setNewUrl(event.target.value)}
                  placeholder="https://github.com/example/repo/raw/main/catalog.json"
                  className="min-h-11 flex-1 rounded-xl border border-line bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-amber"
                />
                <button type="button" onClick={() => void addUrl()} className="inline-flex min-h-11 items-center rounded-full bg-amber px-3 text-xs font-semibold text-ink">
                  Add
                </button>
              </div>
              <ul className="text-xs text-muted">
                {(result?.urls ?? []).map((url) => (
                  <li key={url} className="flex items-center justify-between gap-2 py-1">
                    <span className="min-w-0 truncate">{url}</span>
                    {url !== (result?.urls ?? [])[0] ? (
                      <button type="button" className="font-semibold" onClick={() => void dropUrl(url)}>Remove</button>
                    ) : (
                      <span>Default</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      </div>
      {pending ? (
        <div className="nvr-dialog nvr-dialog-confirm" role="alertdialog" aria-modal="true" aria-labelledby="nvr-install-title">
          <h3 id="nvr-install-title" className="text-base font-semibold text-fg">Install {pending.name}?</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            This downloads {formatPackSize(pending.sizeBytes)} from the catalog, verifies checksums, and adds an overlay under ~/.config/nvr/voices.d. License: {pending.license}.
            {!pending.commercialUse ? " This pack is not for commercial use." : ""}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setPending(null)} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-fg">Cancel</button>
            <button type="button" disabled={busyId === pending.id} onClick={() => void confirmInstall()} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-amber px-4 text-sm font-semibold text-ink disabled:opacity-40">
              {busyId === pending.id ? <Loader2 className="size-4 animate-spin" /> : <Globe className="size-4" />}
              Install pack
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

