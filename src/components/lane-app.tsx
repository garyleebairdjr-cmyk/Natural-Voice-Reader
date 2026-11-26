import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  AudioWaveform,
  Download,
  FileText,
  Keyboard,
  Maximize2,
  Minimize2,
  Shuffle,
  Sparkles,
  Waves,
  X,
  Link2,
  ListEnd,
  Loader2,
  RectangleHorizontal,
  Monitor,
  Moon,
  PanelRight,
  PanelRightClose,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { getTtsStatus, isDesktopApp, prepareTtsEngine, synthesizeSpeech } from "@/lib/platform";
import { APP_VERSION_LABEL } from "@/lib/build-info";
import { readPage } from "@/lib/platform";
import { THEME_COLOR, defaultInk, inksFor, inkFits, migrateInk, resolveTheme, type ThemeName } from "@/lib/appearance";
import {
  cardAfterFinish,
  cardForNext,
  defaultLaneSettings,
  defaultSettingsOpen,
  effectiveGain,
  readLaneSettings,
  SETTINGS_BREAKPOINT,
  SPEED_OPTIONS,
  useLane,
  type PlayMode,
} from "@/lib/lane-store";
import { DEVICE_VOICE, canonicalVoiceId, isVoiceId, voiceAccentLabel, voiceById, voiceForCardIn, VOICES, type Voice } from "@/lib/voices";
import { splitForStreaming } from "@/lib/sentences";
import { isLoadingVoiceError, modelLabel, TTS_MODELS, type TtsStatus } from "@/lib/tts-config";
import { resolveSpeechRoute } from "@/lib/voice-routing";
import { analyserFor, applyPlayback } from "@/lib/soft-room";
import { joinClips } from "@/lib/audio-join";
import { listVoicePacks } from "@/lib/platform";
import { voicesInInstalledPacks, type VoicePackStatus } from "@/lib/voice-packs";
import { VoicePackSettings } from "@/components/voice-pack-settings";
import { VoicePicker } from "@/components/voice-picker";
import { useGoogleSession } from "@/components/google-session";
import { VOICE_PREVIEW_LINE } from "@/lib/voice-picker";
import { VoiceVisualizer } from "@/components/voice-visualizer";
import { formatDuration, pieceAtChar, secondsToRead, wordCount } from "@/lib/reading-time";
import { pieceBounds, progressAt, seekTarget } from "@/lib/seek";

type Phase = "idle" | "loading" | "playing" | "paused";

const PLAY_MODE_OPTIONS: { value: PlayMode; label: string; hint: string; icon: typeof Repeat }[] = [
  { value: "card", label: "Card", hint: "Stop when this card ends. Play continues with the next card.", icon: RectangleHorizontal },
  { value: "queue", label: "Queue", hint: "Play every card, then stop after the last one.", icon: ListEnd },
  { value: "loop", label: "Loop", hint: "Play every card, then start again from the first.", icon: Repeat },
];

type CachedClip = { url: string; speedApplied: boolean };
type PreparedClip = { key: string; url: string; speedApplied: boolean; provider: "cache" | "voicestudio" | "kokoro" | "xai" | "native" };
const audioCache = new Map<string, CachedClip>();
const cacheOrder: string[] = [];
const inflightAudio = new Map<string, Promise<PreparedClip>>();

function remember(key: string, clip: CachedClip) {
  if (audioCache.has(key)) return;
  audioCache.set(key, clip);
  cacheOrder.push(key);
  while (cacheOrder.length > 24) {
    const old = cacheOrder.shift();
    if (!old) break;
    const prev = audioCache.get(old);
    if (prev) URL.revokeObjectURL(prev.url);
    audioCache.delete(old);
  }
}

function b64ToUrl(b64: string, mime: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

export function LaneApp() {
  const cards = useLane((s) => s.cards);
  const index = useLane((s) => s.index);
  const voiceId = useLane((s) => s.voiceId);
  const rotate = useLane((s) => s.rotate);
  const speed = useLane((s) => s.speed);
  const playMode = useLane((s) => s.playMode);
  const ttsModel = useLane((s) => s.ttsModel);
  const setVoice = useLane((s) => s.setVoice);
  const setRotate = useLane((s) => s.setRotate);
  const setTtsModel = useLane((s) => s.setTtsModel);
  const softRoom = useLane((s) => s.softRoom);
  const setSoftRoom = useLane((s) => s.setSoftRoom);
  const volume = useLane((s) => s.volume);
  const muted = useLane((s) => s.muted);
  const setVolume = useLane((s) => s.setVolume);
  const setMuted = useLane((s) => s.setMuted);
  const settingsOpenPref = useLane((s) => s.settingsOpen);
  const setSettingsOpen = useLane((s) => s.setSettingsOpen);
  const favoriteVoiceIds = useLane((s) => s.favoriteVoiceIds);
  const recentVoiceIds = useLane((s) => s.recentVoiceIds);
  const toggleFavorite = useLane((s) => s.toggleFavorite);
  const setSpeed = useLane((s) => s.setSpeed);
  const setPlayMode = useLane((s) => s.setPlayMode);
  const theme = useLane((s) => s.theme);
  const ink = useLane((s) => s.ink);
  const setTheme = useLane((s) => s.setTheme);
  const setInk = useLane((s) => s.setInk);
  const setIndex = useLane((s) => s.setIndex);
  const addPaste = useLane((s) => s.addPaste);
  const addPage = useLane((s) => s.addPage);
  const loadSamples = useLane((s) => s.loadSamples);
  const removeCard = useLane((s) => s.removeCard);
  const clear = useLane((s) => s.clear);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [draft, setDraft] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [source, setSource] = useState<"card" | "link">("card");
  const [reading, setReading] = useState(false);
  const [composerNote, setComposerNote] = useState<string | null>(null);
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const google = useGoogleSession();
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [packs, setPacks] = useState<VoicePackStatus[] | null>(null);
  const [wide, setWide] = useState(true);
  const [confirmAction, setConfirmAction] = useState<null | "clear" | "reset">(null);
  /** The sentence being read, for read-along highlighting and resuming where playback paused. */
  const [spoken, setSpoken] = useState<{ cardId: string; piece: number } | null>(null);
  const spokenRef = useRef<{ cardId: string; piece: number } | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [deviceSpeaking, setDeviceSpeaking] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Where the finger or pointer is on the card bar while dragging, 0 to 1. */
  const [scrub, setScrub] = useState<number | null>(null);
  const [stageVisible, setStageVisible] = useState(true);
  const stageRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const installedVoices = useMemo(() => {
    if (!packs) return VOICES;
    const catalogVoices = voicesInInstalledPacks(packs);
    return catalogVoices.map((item) => {
      if (isVoiceId(item.id)) {
        const known = voiceById(item.id);
        return { ...known, accent: item.accent ?? known.accent, gender: item.gender ?? known.gender };
      }
      return {
        id: item.id,
        name: item.name,
        note: item.note ?? "",
        language: item.language,
        accent: item.accent,
        gender: item.gender,
      };
    });
  }, [packs]);

  const availableEngines = useMemo(() => {
    if (!packs) return TTS_MODELS.map((model) => model.id);
    return TTS_MODELS.filter((model) => model.id !== "omnivoice" || packs.some((pack) => pack.id === "omnivoice" && pack.installed)).map((model) => model.id);
  }, [packs]);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const prefetchAbort = useRef<AbortController[]>([]);
  const deviceKeep = useRef<number | null>(null);
  const loadedKey = useRef<string | null>(null);
  const playingId = useRef<string | null>(null);
  const speedAppliedRef = useRef(false);
  const endedWaiter = useRef<((ok: boolean) => void) | null>(null);
  const modeRef = useRef<"lane" | "audition">("lane");
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const advanceRef = useRef<(fromIndex: number) => void>(() => {});
  /** Which spoken piece of the current card is loaded, so progress covers the whole card. */
  const pieceRef = useRef<{ index: number; count: number; bounds: number[] }>({ index: 0, count: 1, bounds: [0, 1] });

  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const card = cards[index];
  const speaking = card ? voiceForCardIn(installedVoices, index, voiceId, rotate) : voiceById(voiceId);

  const [appearanceReady, setAppearanceReady] = useState(false);
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  );
  const resolvedTheme = resolveTheme(theme, prefersDark);

  useEffect(() => {
    const finish = () => {
      const state = useLane.getState();
      const next = canonicalVoiceId(state.voiceId);
      if (next !== state.voiceId) useLane.setState({ voiceId: next });
      setAppearanceReady(true);
    };
    const unsub = useLane.persist.onFinishHydration(finish);
    void useLane.persist.rehydrate();
    return unsub;
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listVoicePacks()
      .then((result) => {
        if (!cancelled) setPacks(result.packs);
      })
      .catch(() => {
        if (!cancelled) setPacks([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!packs) return;
    const allowed = new Set(installedVoices.map((voice) => voice.id));
    if (voiceId !== "device" && !allowed.has(voiceId)) {
      const fallback = allowed.has("leo") ? "leo" : installedVoices[0]?.id ?? "device";
      setVoice(fallback);
    }
    if (ttsModel === "omnivoice" && !availableEngines.includes("omnivoice")) {
      setTtsModel("kittentts");
    }
  }, [packs, installedVoices, availableEngines, voiceId, ttsModel, setVoice, setTtsModel]);

  useEffect(() => {
    if (!appearanceReady) return;
    const activeInk = migrateInk(ink);
    if (activeInk !== ink) setInk(activeInk);
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themePref = theme;
    root.dataset.ink = activeInk;
    root.style.colorScheme = resolvedTheme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLOR[resolvedTheme]);
  }, [appearanceReady, theme, ink, resolvedTheme, setInk]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const d = audio.duration;
      const within = d && Number.isFinite(d) ? audio.currentTime / d : 0;
      if (modeRef.current === "lane") {
        setProgress(progressAt(pieceRef.current.bounds, pieceRef.current.index, within));
      } else {
        setProgress(within);
      }
    };
    const onEnd = () => {
      if (endedWaiter.current) {
        endedWaiter.current(true);
        return;
      }
      if (modeRef.current === "audition") {
        setPhase("idle");
        setProgress(0);
        return;
      }
      advanceRef.current(useLane.getState().index);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
    };
  }, []);

  useEffect(() => {
    const id = playingId.current;
    if (!id || modeRef.current === "audition") return;
    if (!cards.some((c) => c.id === id)) {
      gen.current += 1;
      audioRef.current?.pause();
      loadedKey.current = null;
      playingId.current = null;
      setPhase("idle");
      setProgress(0);
      void releaseScreen();
    }
  }, [cards]);

  useEffect(() => {
    if (audioRef.current && modeRef.current === "lane" && !speedAppliedRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  useEffect(() => {
    const gain = effectiveGain(volume, muted);
    const audio = audioRef.current;
    if (audio) applyPlayback(audio, { softRoom, gain });
    if (utteranceRef.current) utteranceRef.current.volume = gain;
  }, [softRoom, volume, muted]);

  useEffect(() => {
    let cancelled = false;
    setTtsStatus((current) => ({
      provider: current?.provider ?? "voicestudio",
      model: ttsModel,
      state: "loading",
      voicestudioUp: Boolean(current?.voicestudioUp),
      xaiConfigured: Boolean(current?.xaiConfigured),
      message: `Loading voice engine (${modelLabel(ttsModel)}). The first load can take a minute.`,
    }));
    void prepareTtsEngine({ data: { model: ttsModel } })
      .then((status) => {
        if (!cancelled) setTtsStatus(status);
      })
      .catch(() => {
        void getTtsStatus()
          .then((status) => {
            if (!cancelled) setTtsStatus(status);
          })
          .catch(() => {});
      });
    return () => {
      cancelled = true;
    };
  }, [ttsModel]);

  useEffect(() => {
    if (ttsStatus?.state !== "loading" && ttsStatus?.state !== "downloading") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getTtsStatus()
        .then((status) => {
          if (!cancelled) setTtsStatus(status);
        })
        .catch(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ttsStatus?.state]);

  // Installing or removing a pack in Settings changes which voices work, so
  // refresh the status line then. Skip the first pack list, which only
  // reports what was already there when the app opened.
  const packKey = packs?.map((pack) => `${pack.id}:${pack.installed ? 1 : 0}${pack.installing ? 1 : 0}`).join(",") ?? null;
  const lastPackKey = useRef<string | null>(null);
  useEffect(() => {
    if (packKey === null) return;
    const previous = lastPackKey.current;
    lastPackKey.current = packKey;
    if (previous === null || previous === packKey) return;
    let cancelled = false;
    void getTtsStatus()
      .then((status) => {
        if (!cancelled) setTtsStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [packKey]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && phaseRef.current === "playing") {
        void holdScreen();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(SETTINGS_BREAKPOINT);
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const settingsOpen = settingsOpenPref ?? defaultSettingsOpen(wide);

  // Show the floating mini player once the main stage scrolls out of view.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setStageVisible(Boolean(entry?.isIntersecting)), { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Keep the live sentence in view on long cards while the stage is on screen.
  useEffect(() => {
    if (phase !== "playing" || !stageVisible || !spoken) return;
    const el = document.querySelector<HTMLElement>(`[data-piece="${spoken.piece}"][data-state="live"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [spoken, phase, stageVisible]);

  // Drop .txt or .md files anywhere to queue them.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void addFilesRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  const pickerVoices = useMemo(() => [DEVICE_VOICE, ...installedVoices], [installedVoices]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || (e.target as HTMLElement | null)?.isContentEditable;
      if ((e.key === "," && (e.ctrlKey || e.metaKey)) || (e.key === "," && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        setSettingsOpen(!settingsOpen);
        return;
      }
      if (e.key === "Escape" && settingsOpen) {
        const dialog = (e.target as HTMLElement | null)?.closest("[role='dialog'], [role='alertdialog']");
        if (!dialog) {
          e.preventDefault();
          setSettingsOpen(false);
          return;
        }
      }
      if (typing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setShowKeys((open) => !open);
        return;
      }
      if (e.key === "Escape") {
        setShowKeys(false);
        setFocusMode(false);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setFocusMode((on) => !on);
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        const state = useLane.getState();
        state.setMuted(!(state.muted || state.volume === 0));
        return;
      }
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const state = useLane.getState();
        const at = SPEED_OPTIONS.findIndex((opt) => opt.value === state.speed);
        const nextAt = Math.min(SPEED_OPTIONS.length - 1, Math.max(0, (at < 0 ? 1 : at) + (e.key === "]" ? 1 : -1)));
        state.setSpeed(SPEED_OPTIONS[nextAt]!.value);
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        toggleRef.current();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nextRef.current();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const play = () => toggleRef.current();
    const pause = () => pauseRef.current();
    try {
      navigator.mediaSession.setActionHandler("play", play);
      navigator.mediaSession.setActionHandler("pause", pause);
      navigator.mediaSession.setActionHandler("nexttrack", () => nextRef.current());
      navigator.mediaSession.setActionHandler("previoustrack", () => prevRef.current());
    } catch {
      /* some embedded browsers reject handlers */
    }
  }, []);

  async function holdScreen() {
    if (!("wakeLock" in navigator)) return;
    try {
      if (wakeRef.current) return;
      wakeRef.current = await navigator.wakeLock.request("screen");
      wakeRef.current.addEventListener("release", () => {
        wakeRef.current = null;
      });
    } catch {
      wakeRef.current = null;
    }
  }

  async function releaseScreen() {
    try {
      await wakeRef.current?.release();
    } catch {
      /* already released */
    }
    wakeRef.current = null;
  }

  function publishSession(title: string, artist: string, playing: boolean) {
    if (!("mediaSession" in navigator)) return;
    const label = title.length > 80 ? `${title.slice(0, 77)}…` : title;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: label,
      artist,
      album: "Natural Voice Reader",
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  function stopDevice() {
    if (deviceKeep.current != null) {
      window.clearInterval(deviceKeep.current);
      deviceKeep.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  function audioCacheKey(voice: string, text: string, model: string, speed: number) {
    return `${model}\0${voice}\0${speed}\0${text}`;
  }

  async function ensureAudio(text: string, voice: string, signal?: AbortSignal) {
    const state = useLane.getState();
    const model = state.ttsModel;
    const speed = state.speed;
    const route = resolveSpeechRoute(voice, model);
    const key = audioCacheKey(voice, text, route.cacheKey, speed);
    const hit = audioCache.get(key);
    if (hit) return { key, url: hit.url, speedApplied: hit.speedApplied, provider: "cache" as const };
    const pending = inflightAudio.get(key);
    if (pending) return pending;
    const work = loadAudio(key, text, voice, model, speed, signal).finally(() => {
      inflightAudio.delete(key);
    });
    inflightAudio.set(key, work);
    return work;
  }

  async function loadAudio(
    key: string,
    text: string,
    voice: string,
    model: string,
    speed: number,
    signal?: AbortSignal,
  ) {
    const request = () => synthesizeSpeech({ data: { text, voiceId: voice, speed, model }, signal });
    let result = await request();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!result.ok && (result.loading || isLoadingVoiceError(result.error))) {
      setTtsStatus((current) => ({
        provider: current?.provider ?? "voicestudio",
        model,
        state: "loading",
        voicestudioUp: Boolean(current?.voicestudioUp),
        xaiConfigured: Boolean(current?.xaiConfigured),
        message: result.ok ? current?.message ?? "" : result.error,
      }));
      result = await request();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
    if (!result.ok) {
      const loading = Boolean(result.loading) || isLoadingVoiceError(result.error);
      const message = loading && !isLoadingVoiceError(result.error)
        ? `Loading voice engine. ${result.error}`
        : loading && !result.error.toLowerCase().includes("loading voice engine")
          ? "Loading voice engine. The first load can take a minute on this computer."
          : result.error;
      if (loading) {
        setTtsStatus((current) => ({
          provider: current?.provider ?? "voicestudio",
          model,
          state: "loading",
          voicestudioUp: Boolean(current?.voicestudioUp),
          xaiConfigured: Boolean(current?.xaiConfigured),
          message,
        }));
      }
      throw new Error(message);
    }
    const url = b64ToUrl(result.audio, result.mime);
    remember(key, { url, speedApplied: result.speedApplied });
    if (result.provider === "voicestudio" || result.provider === "xai" || result.provider === "kokoro" || result.provider === "native") {
      const message = result.provider === "native"
        ? `Using voices on this device (${result.model === "kokoro" ? "Kokoro" : "KittenTTS"}).`
        : result.provider === "kokoro"
        ? "Using local Kokoro for this voice."
        : result.provider === "voicestudio"
          ? `Using local VoiceStudio (${modelLabel(result.model)}).`
          : "VoiceStudio is not running. Using the xAI cloud voice.";
      setTtsStatus((current) => ({
        provider: result.provider,
        model: result.model,
        state: "ready",
        voicestudioUp: result.provider === "voicestudio" || Boolean(current?.voicestudioUp),
        xaiConfigured: result.provider === "xai" || Boolean(current?.xaiConfigured),
        message,
      }));
    }
    return { key, url, speedApplied: result.speedApplied, provider: result.provider };
  }

  function abortPrefetch() {
    for (const ac of prefetchAbort.current) ac.abort();
    prefetchAbort.current = [];
  }

  function prefetchSentence(text: string, voice: string) {
    const state = useLane.getState();
    if (state.voiceId === "device") return;
    const key = audioCacheKey(voice, text, resolveSpeechRoute(voice, state.ttsModel).cacheKey, state.speed);
    if (audioCache.has(key) || inflightAudio.has(key)) return;
    const ac = new AbortController();
    prefetchAbort.current.push(ac);
    void ensureAudio(text, voice, ac.signal).catch(() => {});
  }

  function prefetchUpcoming(pieces: string[], fromPiece: number, cardIndex: number, voice: string) {
    const upcoming = pieces.slice(fromPiece + 1, fromPiece + 3);
    if (upcoming.length < 2) {
      const state = useLane.getState();
      const nextCard = state.cards[cardIndex + 1];
      if (nextCard && state.voiceId !== "device") {
        const nextVoice = voiceForCardIn(installedVoices, cardIndex + 1, state.voiceId, state.rotate);
        const nextPieces = splitForStreaming(nextCard.text);
        const need = 2 - upcoming.length;
        // Next card may use a different voice when rotation is on.
        if (nextVoice.id === voice) upcoming.push(...nextPieces.slice(0, need));
        else {
          for (const piece of upcoming) prefetchSentence(piece, voice);
          for (const piece of nextPieces.slice(0, need)) prefetchSentence(piece, nextVoice.id);
          return;
        }
      }
    }
    for (const piece of upcoming) prefetchSentence(piece, voice);
  }

  function waitForAudioEnd(token: number): Promise<void> {
    const audio = audioRef.current;
    if (!audio) return Promise.resolve();
    if (audio.ended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (ok: boolean) => {
        if (endedWaiter.current !== finish) return;
        endedWaiter.current = null;
        if (token !== gen.current) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (ok) resolve();
        else reject(new DOMException("Aborted", "AbortError"));
      };
      endedWaiter.current = finish;
    });
  }

  function markPiece(cardId: string, piece: number) {
    const next = { cardId, piece };
    spokenRef.current = next;
    setSpoken(next);
  }

  /** Route playback through Web Audio once, inside the user's gesture, so the visualizer can read it. */
  function wireVisualizer() {
    const audio = audioRef.current;
    if (!audio || analyser) return;
    const node = analyserFor(audio);
    if (node) setAnalyser(node);
  }

  function playDevice(text: string, token: number, rate: number, onChar?: (charIndex: number) => void) {
    return new Promise<void>((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("This browser has no device voice."));
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = Math.min(1.6, Math.max(0.6, rate));
      utterance.volume = effectiveGain(useLane.getState().volume, useLane.getState().muted);
      utteranceRef.current = utterance;
      const voices = window.speechSynthesis.getVoices();
      const picked =
        voices.find((v) => /^en/i.test(v.lang) && /natural|google|samantha|daniel|aria|jenny/i.test(v.name)) ??
        voices.find((v) => /^en/i.test(v.lang));
      if (picked) utterance.voice = picked;
      utterance.onboundary = (event) => {
        if (token !== gen.current || text.length === 0) return;
        if (onChar) onChar(event.charIndex);
        else setProgress(Math.min(1, event.charIndex / text.length));
      };
      const clearKeep = () => {
        setDeviceSpeaking(false);
        if (deviceKeep.current != null) {
          window.clearInterval(deviceKeep.current);
          deviceKeep.current = null;
        }
      };
      utterance.onend = () => {
        clearKeep();
        if (utteranceRef.current === utterance) utteranceRef.current = null;
        if (token !== gen.current) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        resolve();
      };
      utterance.onerror = (event) => {
        clearKeep();
        if (utteranceRef.current === utterance) utteranceRef.current = null;
        if (event.error === "interrupted" || event.error === "canceled") {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        reject(new Error("The device voice stopped."));
      };
      deviceKeep.current = window.setInterval(() => {
        if (!window.speechSynthesis.speaking) return;
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 10000);
      setDeviceSpeaking(true);
      window.speechSynthesis.speak(utterance);
    });
  }

  function advanceAfter(fromIndex: number) {
    const state = useLane.getState();
    const upcoming = cardAfterFinish(fromIndex, state.cards.length, state.playMode);
    if (upcoming !== null) {
      void playAtRef.current(upcoming);
      return;
    }
    setPhase("idle");
    playingId.current = null;
    loadedKey.current = null;
    void releaseScreen();
    // In card mode, cue the next card so Play continues instead of repeating this one.
    const cued = state.playMode === "card" ? cardForNext(fromIndex, state.cards.length, "queue") : null;
    if (cued !== null) {
      state.setIndex(cued);
      setProgress(0);
    } else {
      setProgress(1);
    }
    const current = state.cards[fromIndex];
    if (current) {
      publishSession(current.text, voiceForCardIn(installedVoices, fromIndex, state.voiceId, state.rotate).name, false);
    }
  }
  advanceRef.current = advanceAfter;

  async function playGeneratedPieces(pieces: string[], voice: string, token: number, startAt: number, cardId: string) {
    const audio = audioRef.current;
    if (!audio) return;
    pieceRef.current = { ...pieceRef.current, count: pieces.length, bounds: pieceBounds(pieces) };
    for (let i = startAt; i < pieces.length; i++) {
      if (token !== gen.current || modeRef.current !== "lane") return;
      pieceRef.current.index = i;
      markPiece(cardId, i);
      const piece = pieces[i]!;
      prefetchUpcoming(pieces, i, useLane.getState().index, voice);
      const { key, url, speedApplied } = await ensureAudio(piece, voice, abortRef.current?.signal);
      if (token !== gen.current) return;
      speedAppliedRef.current = speedApplied;
      if (loadedKey.current !== key) {
        audio.src = url;
        loadedKey.current = key;
      }
      audio.playbackRate = speedApplied ? 1 : useLane.getState().speed;
      applyPlayback(audio, { softRoom: useLane.getState().softRoom, gain: effectiveGain(useLane.getState().volume, useLane.getState().muted) });
      await audio.play();
      if (token !== gen.current) {
        audio.pause();
        return;
      }
      setProgress(progressAt(pieceRef.current.bounds, i, audio.currentTime && audio.duration ? audio.currentTime / audio.duration : 0));
      await waitForAudioEnd(token);
    }
  }

  /** Speak from one sentence to the end of the card with the device voice, tracking the live sentence. */
  function speakOnDevice(pieces: string[], from: number, item: { id: string; text: string }, token: number) {
    const rest = pieces.length > 0 ? pieces.slice(from) : [item.text];
    const text = rest.join(" ");
    const bounds = pieceBounds(pieces);
    // Where each remaining sentence starts in the spoken text (joined by single spaces).
    const starts: number[] = [];
    rest.reduce((at, piece) => (starts.push(at), at + piece.length + 1), 0);
    pieceRef.current = { index: from, count: Math.max(1, pieces.length), bounds };
    return playDevice(text, token, useLane.getState().speed, (charIndex) => {
      const local = pieceAtChar(rest, charIndex);
      const within = (charIndex - (starts[local] ?? 0)) / Math.max(1, rest[local]?.length ?? 1);
      const piece = local + from;
      setProgress(progressAt(bounds, piece, within));
      if (spokenRef.current?.cardId !== item.id || spokenRef.current.piece !== piece) markPiece(item.id, piece);
    });
  }

  async function playAt(nextIndex: number, startPiece = 0) {
    const state = useLane.getState();
    const nextCard = state.cards[nextIndex];
    if (!nextCard) {
      setPhase("idle");
      return;
    }
    wireVisualizer();
    const token = ++gen.current;
    endedWaiter.current = null;
    stopDevice();
    state.setIndex(nextIndex);
    const voice = voiceForCardIn(installedVoices, nextIndex, state.voiceId, state.rotate);
    setPhase("loading");
    setError(null);
    setNote(null);
    setAuditionId(null);
    pieceRef.current = { index: 0, count: 1, bounds: [0, 1] };
    modeRef.current = "lane";
    const allPieces = splitForStreaming(nextCard.text);
    const from = Math.min(Math.max(0, startPiece), Math.max(0, allPieces.length - 1));
    markPiece(nextCard.id, from);

    const markPlaying = () => {
      playingId.current = nextCard.id;
      setPhase("playing");
      void holdScreen();
      publishSession(nextCard.text, voice.name, true);
    };

    try {
      if (voice.id === "device") {
        markPlaying();
        await speakOnDevice(allPieces, from, nextCard, token);
        if (token !== gen.current || modeRef.current !== "lane") return;
        advanceRef.current(nextIndex);
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const pieces = allPieces;
      if (pieces.length === 0) {
        setPhase("idle");
        return;
      }
      pieceRef.current = { index: from, count: pieces.length, bounds: pieceBounds(pieces) };
      const first = await ensureAudio(pieces[from]!, voice.id, ac.signal);
      if (token !== gen.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      speedAppliedRef.current = first.speedApplied;
      audio.src = first.url;
      loadedKey.current = first.key;
      audio.playbackRate = first.speedApplied ? 1 : useLane.getState().speed;
      prefetchUpcoming(pieces, from, nextIndex, voice.id);
      applyPlayback(audio, { softRoom: useLane.getState().softRoom, gain: effectiveGain(useLane.getState().volume, useLane.getState().muted) });
      await audio.play();
      if (token !== gen.current) {
        audio.pause();
        return;
      }
      markPlaying();
      await waitForAudioEnd(token);
      if (token !== gen.current || modeRef.current !== "lane") return;
      if (pieces.length > from + 1) {
        await playGeneratedPieces(pieces, voice.id, token, from + 1, nextCard.id);
      }
      if (token !== gen.current || modeRef.current !== "lane") return;
      advanceRef.current(nextIndex);
    } catch (err) {
      if (isAbort(err) || token !== gen.current) return;
      const failed = err instanceof Error ? err.message : "Could not read that card.";
      if (voice.id !== "device" && isLoadingVoiceError(failed)) {
        setNote(null);
        setError(null);
        setTtsStatus((current) => ({
          provider: current?.provider ?? "voicestudio",
          model: useLane.getState().ttsModel,
          state: "loading",
          voicestudioUp: Boolean(current?.voicestudioUp),
          xaiConfigured: Boolean(current?.xaiConfigured),
          message: failed.toLowerCase().includes("loading voice engine")
            ? failed
            : "Loading voice engine. The first load can take a minute on this computer.",
        }));
        setPhase("paused");
        void releaseScreen();
        return;
      }
      if (voice.id !== "device") {
        setNote(
          "Generated audio was not available, so this card is using the browser's device voice. Leo, Eve and the others will sound the same until VoiceStudio is running or an xAI key is set.",
        );
        try {
          markPlaying();
          await speakOnDevice(allPieces, from, nextCard, token);
          if (token !== gen.current || modeRef.current !== "lane") return;
          advanceRef.current(nextIndex);
          return;
        } catch (deviceErr) {
          if (isAbort(deviceErr) || token !== gen.current) return;
        }
      }
      setPhase("paused");
      setError(err instanceof Error ? err.message : "Could not read that card.");
      void releaseScreen();
    }
  }

  const playAtRef = useRef(playAt);
  playAtRef.current = playAt;

  function pause() {
    gen.current += 1;
    endedWaiter.current?.(false);
    endedWaiter.current = null;
    abortRef.current?.abort();
    stopDevice();
    audioRef.current?.pause();
    setPhase("paused");
    void releaseScreen();
    const state = useLane.getState();
    const current = state.cards[state.index];
    if (current) publishSession(current.text, voiceForCardIn(installedVoices, state.index, state.voiceId, state.rotate).name, false);
  }
  const pauseRef = useRef(pause);
  pauseRef.current = pause;

  function toggle() {
    const state = useLane.getState();
    if (state.cards.length === 0) return;
    if (phaseRef.current === "playing" || phaseRef.current === "loading") {
      pause();
      return;
    }
    wireVisualizer();
    const current = state.cards[state.index];
    if (!current) return;
    const voice = voiceForCardIn(installedVoices, state.index, state.voiceId, state.rotate);
    const pieces = splitForStreaming(current.text);
    const at = phaseRef.current === "paused" && spokenRef.current?.cardId === current.id ? spokenRef.current.piece : 0;
    const audio = audioRef.current;
    const key = voice.id === "device"
      ? null
      : audioCacheKey(voice.id, pieces[at] ?? current.text, resolveSpeechRoute(voice.id, state.ttsModel).cacheKey, state.speed);
    if (
      phaseRef.current === "paused" &&
      audio &&
      key &&
      loadedKey.current === key &&
      playingId.current === current.id &&
      !audio.ended
    ) {
      // Pick up mid-sentence, then carry on with the rest of the card.
      const token = ++gen.current;
      modeRef.current = "lane";
      abortRef.current = new AbortController();
      pieceRef.current = { index: at, count: Math.max(1, pieces.length), bounds: pieceBounds(pieces) };
      audio.playbackRate = speedAppliedRef.current ? 1 : state.speed;
      applyPlayback(audio, { softRoom: state.softRoom, gain: effectiveGain(state.volume, state.muted) });
      const cardIndex = state.index;
      void (async () => {
        try {
          await audio.play();
          if (token !== gen.current) return;
          setPhase("playing");
          void holdScreen();
          publishSession(current.text, voice.name, true);
          await waitForAudioEnd(token);
          if (token !== gen.current || modeRef.current !== "lane") return;
          if (at + 1 < pieces.length) await playGeneratedPieces(pieces, voice.id, token, at + 1, current.id);
          if (token !== gen.current || modeRef.current !== "lane") return;
          advanceRef.current(cardIndex);
        } catch (err) {
          if (isAbort(err) || token !== gen.current) return;
          setPhase("paused");
          setError(err instanceof Error ? err.message : "Could not resume that card.");
        }
      })();
      return;
    }
    void playAt(state.index, at);
  }
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  /**
   * Move to a point on the card bar. Inside the sentence whose audio is loaded
   * this seeks by time; anywhere else it goes to the start of that sentence,
   * since later sentences are only generated when they are needed. While
   * playing, reading continues from there; while paused, that sentence is
   * cued so Play starts from it.
   */
  function seekCard(fraction: number) {
    const state = useLane.getState();
    const current = state.cards[state.index];
    if (!current) return;
    const pieces = splitForStreaming(current.text);
    if (pieces.length === 0) return;
    const bounds = pieceBounds(pieces);
    const { piece, within } = seekTarget(bounds, fraction);
    const voice = voiceForCardIn(installedVoices, state.index, state.voiceId, state.rotate);
    const audio = audioRef.current;
    const phaseNow = phaseRef.current;
    const loadedKeyForPiece =
      voice.id === "device"
        ? null
        : audioCacheKey(voice.id, pieces[piece]!, resolveSpeechRoute(voice.id, state.ttsModel).cacheKey, state.speed);
    const loadedHere =
      loadedKeyForPiece !== null &&
      loadedKey.current === loadedKeyForPiece &&
      playingId.current === current.id &&
      modeRef.current === "lane" &&
      (phaseNow === "playing" || phaseNow === "paused") &&
      audio !== null &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0;
    if (loadedHere && audio) {
      audio.currentTime = Math.min(audio.duration - 0.05, within * audio.duration);
      pieceRef.current = { index: piece, count: pieces.length, bounds };
      markPiece(current.id, piece);
      setProgress(progressAt(bounds, piece, within));
      return;
    }
    if (phaseNow === "playing" || phaseNow === "loading" || modeRef.current === "audition") {
      void playAt(state.index, piece);
      return;
    }
    // Paused or stopped: cue the sentence without starting.
    pieceRef.current = { index: piece, count: pieces.length, bounds };
    markPiece(current.id, piece);
    setProgress(bounds[piece] ?? 0);
    setPhase("paused");
  }

  function next() {
    const state = useLane.getState();
    const upcoming = cardForNext(state.index, state.cards.length, state.playMode);
    if (upcoming !== null) void playAt(upcoming);
  }
  const nextRef = useRef(next);
  nextRef.current = next;

  function prev() {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3 && (phaseRef.current === "playing" || phaseRef.current === "paused")) {
      audio.currentTime = 0;
      setProgress(0);
      if (phaseRef.current === "paused") void toggleRef.current();
      return;
    }
    const i = useLane.getState().index;
    void playAt(Math.max(0, i - 1));
  }
  const prevRef = useRef(prev);
  prevRef.current = prev;

  async function audition(voice: Voice) {
    if (phaseRef.current === "playing" || phaseRef.current === "loading") pause();
    wireVisualizer();
    const token = ++gen.current;
    endedWaiter.current = null;
    setAuditionId(voice.id);
    setError(null);
    setNote(null);
    setVoice(voice.id);
    modeRef.current = "audition";
    try {
      if (voice.id === "device") {
        await playDevice(`This is the device voice. I'll read the next post.`, token, 1);
        if (token !== gen.current) return;
        setPhase("idle");
        return;
      }
      const line = `This is ${voice.name}. I'll read the next post.`;
      const { url, speedApplied, key } = await ensureAudio(line, voice.id);
      if (token !== gen.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      speedAppliedRef.current = speedApplied;
      audio.src = url;
      loadedKey.current = key;
      playingId.current = null;
      audio.playbackRate = speedApplied ? 1 : 1;
      applyPlayback(audio, { softRoom: useLane.getState().softRoom, gain: effectiveGain(useLane.getState().volume, useLane.getState().muted) });
      await audio.play();
      if (token !== gen.current) {
        audio.pause();
        return;
      }
      setPhase("playing");
      await waitForAudioEnd(token);
      if (token === gen.current) setPhase("idle");
    } catch (err) {
      if (isAbort(err) || token !== gen.current) return;
      setPhase("paused");
      setError(err instanceof Error ? err.message : "Could not preview that voice.");
    } finally {
      if (token === gen.current) setAuditionId(null);
    }
  }


  async function previewVoice(voice: Voice) {
    if (phaseRef.current === "playing" || phaseRef.current === "loading") pause();
    wireVisualizer();
    const token = ++gen.current;
    endedWaiter.current = null;
    setAuditionId(voice.id);
    setError(null);
    setNote(null);
    modeRef.current = "audition";
    try {
      if (voice.id === "device") {
        await playDevice("This is a short preview of the device voice.", token, 1);
        if (token !== gen.current) return;
        setPhase("idle");
        return;
      }
      const { url, speedApplied, key } = await ensureAudio(VOICE_PREVIEW_LINE, voice.id);
      if (token !== gen.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      speedAppliedRef.current = speedApplied;
      audio.src = url;
      loadedKey.current = key;
      playingId.current = null;
      audio.playbackRate = 1;
      applyPlayback(audio, { softRoom: useLane.getState().softRoom, gain: effectiveGain(useLane.getState().volume, useLane.getState().muted) });
      await audio.play();
      if (token !== gen.current) {
        audio.pause();
        return;
      }
      setPhase("playing");
      await waitForAudioEnd(token);
      if (token === gen.current) setPhase("idle");
    } catch (err) {
      if (isAbort(err) || token !== gen.current) return;
      setPhase("paused");
      setError(err instanceof Error ? err.message : "Could not preview that voice.");
    } finally {
      if (token === gen.current) setAuditionId(null);
    }
  }

  function settingsToggle() {
    return (
      <button
        type="button"
        onClick={() => setSettingsOpen(!settingsOpen)}
        aria-pressed={settingsOpen}
        aria-keyshortcuts=","
        aria-label={settingsOpen ? "Hide settings" : "Show settings"}
        title={settingsOpen ? "Hide settings (,)" : "Show settings (,)"}
        className="chip inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold text-fg"
      >
        {settingsOpen ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
        <span className="hidden sm:inline">{settingsOpen ? "Hide settings" : "Settings"}</span>
      </button>
    );
  }

  function voicePicker(compact: boolean) {
    return (
      <VoicePicker
        voices={pickerVoices}
        value={voiceId}
        onChange={setVoice}
        onPreview={(voice) => void previewVoice(voice)}
        auditionId={auditionId}
        favoriteIds={favoriteVoiceIds}
        recentIds={recentVoiceIds}
        onToggleFavorite={toggleFavorite}
        ttsModel={ttsModel}
        packs={packs}
        compact={compact}
      />
    );
  }

  function askClearQueue() {
    if (cards.length === 0) return;
    setConfirmAction("clear");
  }

  function askResetSettings() {
    setConfirmAction("reset");
  }

  function runClearQueue() {
    const snapshot = { cards: useLane.getState().cards, index: useLane.getState().index };
    pause();
    clear();
    setProgress(0);
    loadedKey.current = null;
    playingId.current = null;
    setConfirmAction(null);
    toast("Queue cleared", {
      duration: 8000,
      action: {
        label: "Undo",
        onClick: () => useLane.setState({ cards: snapshot.cards, index: snapshot.index }),
      },
    });
  }

  function runResetSettings() {
    const snapshot = readLaneSettings(useLane.getState());
    const defaults = defaultLaneSettings();
    useLane.setState({
      ...defaults,
      settingsOpen: defaultSettingsOpen(wide),
    });
    setConfirmAction(null);
    toast("Settings reset to defaults", {
      duration: 8000,
      action: {
        label: "Undo",
        onClick: () => useLane.setState(snapshot),
      },
    });
  }

  function laneNote(count: number, mode: "append" | "replace", extra = "") {
    const noun = count === 1 ? "card" : "cards";
    const base = mode === "replace" ? `Queue replaced with ${count} ${noun}.` : `Added ${count} ${noun}.`;
    return base + extra;
  }

  function stopForReplace() {
    gen.current += 1;
    abortRef.current?.abort();
    abortPrefetch();
    stopDevice();
    audioRef.current?.pause();
    loadedKey.current = null;
    playingId.current = null;
    setPhase("idle");
    setProgress(0);
  }

  function commitPaste(mode: "append" | "replace") {
    const count = addPaste(draft, mode);
    if (count === 0) {
      setComposerNote("Paste a post or a few paragraphs first.");
      return;
    }
    setDraft("");
    setComposerNote(laneNote(count, mode));
    if (mode === "replace") stopForReplace();
  }

  async function commitPage(mode: "append" | "replace") {
    const url = pageUrl.trim();
    if (!url) {
      setComposerNote("Enter a link first.");
      return;
    }
    setReading(true);
    setComposerNote(null);
    try {
      const result = await readPage({ data: { url } });
      if (!result.ok) {
        setComposerNote(result.error);
        return;
      }
      const count = addPage(result.text, mode);
      if (count === 0) {
        setComposerNote("That page didn't include readable text.");
        return;
      }
      setComposerNote(laneNote(count, mode, result.trimmed ? " The page was long, so only the first part was kept." : ""));
      if (mode === "replace") stopForReplace();
    } catch {
      setComposerNote("Could not read that page.");
    } finally {
      setReading(false);
    }
  }

  async function addFiles(files: File[]) {
    const readable = files.filter((file) => /^text\//.test(file.type) || /\.(txt|md|markdown|text)$/i.test(file.name));
    if (readable.length === 0) {
      setComposerNote(files.length ? "Only plain text and Markdown files can be added." : null);
      return;
    }
    let added = 0;
    for (const file of readable) {
      const text = await file.text();
      added += addPaste(text, "append");
    }
    const names = readable.length === 1 ? readable[0]!.name : `${readable.length} files`;
    setComposerNote(added ? `Added ${added} ${added === 1 ? "card" : "cards"} from ${names}.` : `${names} had no readable text.`);
    if (added) toast(`Queued ${names}`, { description: `${added} ${added === 1 ? "card" : "cards"} added` });
  }
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  function saveFile(url: string, name: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function downloadCard(cardIndex: number) {
    const state = useLane.getState();
    const item = state.cards[cardIndex];
    if (!item) return;
    const voice = voiceForCardIn(installedVoices, cardIndex, state.voiceId, state.rotate);
    if (voice.id === "device") {
      setError("Device voices play in the browser and don't make a file. Choose Leo or another voice to download.");
      return;
    }
    setDownloadingId(item.id);
    setError(null);
    try {
      // Same pieces as playback, so anything already heard comes from the cache.
      const pieces = splitForStreaming(item.text);
      const clips: Blob[] = [];
      for (let i = 0; i < pieces.length; i++) {
        if (pieces.length > 2) setNote(`Preparing the download: ${i + 1} of ${pieces.length} sentences.`);
        const { url } = await ensureAudio(pieces[i]!, voice.id);
        clips.push(await fetch(url).then((res) => res.blob()));
      }
      if (pieces.length > 2) setNote(null);
      const joined = await joinClips(clips);
      const voiceSlug = voice.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "voice";
      const filename = `natural-reader-${String(cardIndex + 1).padStart(2, "0")}-${voiceSlug}.${joined.extension}`;
      const objectUrl = URL.createObjectURL(joined.blob);
      try {
        await google.api.finishDownload(objectUrl, filename);
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      }
    } catch (err) {
      setNote(null);
      if (!isAbort(err)) setError(err instanceof Error ? err.message : "Could not download that card.");
    } finally {
      setDownloadingId((current) => (current === item.id ? null : current));
    }
  }

  function chooseTheme(next: ThemeName) {
    setTheme(next);
    if (!inkFits(next, ink)) setInk(defaultInk());
  }

  const countLabel = cards.length === 0 ? "Empty queue" : `${index + 1} of ${cards.length}`;
  const inks = inksFor();
  const isLive = phase === "playing" || phase === "loading";
  const volumeOff = muted || volume === 0;

  const cardPieces = useMemo(() => (card ? splitForStreaming(card.text) : []), [card]);
  const spokenHere = card && spoken && spoken.cardId === card.id && phase !== "idle" && !auditionId ? spoken.piece : null;
  const cardWords = useMemo(() => (card ? wordCount(card.text) : 0), [card]);
  const laterWords = useMemo(
    () => cards.slice(index + 1).reduce((sum, item) => sum + wordCount(item.text), 0),
    [cards, index],
  );
  const cardSeconds = secondsToRead(cardWords, speed);
  const leftOnCard = cardSeconds * (1 - Math.min(1, Math.max(0, progress)));
  const leftInQueue = leftOnCard + secondsToRead(laterWords, speed);
  const showMini = !stageVisible && cards.length > 0 && !focusMode;
  const bounds = useMemo(() => pieceBounds(cardPieces), [cardPieces]);
  const scrubTarget = scrub === null || !card || cardPieces.length === 0 ? null : seekTarget(bounds, scrub);
  const currentPiece = spokenHere ?? seekTarget(bounds, progress).piece;
  const voiceIsDevice = speaking.id === "device";
  // While dragging, show where release will land: exact inside the loaded sentence, else the sentence start.
  const barFraction =
    scrubTarget === null
      ? progress
      : !voiceIsDevice && spokenHere === scrubTarget.piece && phase !== "idle" && phase !== "loading"
        ? scrub!
        : bounds[scrubTarget.piece] ?? 0;

  function themeButton(value: ThemeName, label: string, Icon: typeof Sun) {
    return (
      <button type="button" onClick={() => chooseTheme(value)} aria-pressed={theme === value} aria-label={label} title={label}>
        <Icon className="size-4" />
        <span className="hidden xl:inline">{label}</span>
      </button>
    );
  }

  function playButton(size: "lg" | "sm") {
    const big = size === "lg";
    return (
      <button
        type="button"
        aria-label={isLive ? "Pause" : "Play"}
        onClick={toggle}
        disabled={cards.length === 0}
        data-live={phase === "playing" && big ? "true" : undefined}
        className={
          "nvr-play btn-accent inline-flex shrink-0 items-center justify-center rounded-full " +
          (big ? "size-20 sm:size-[5.5rem]" : "size-12")
        }
      >
        {phase === "loading" ? (
          <Loader2 className={(big ? "size-8" : "size-5") + " animate-spin"} />
        ) : phase === "playing" ? (
          <Pause className={(big ? "size-8" : "size-5") + " fill-current"} />
        ) : (
          <Play className={(big ? "size-8" : "size-5") + " translate-x-0.5 fill-current"} />
        )}
      </button>
    );
  }

  function skipButton(kind: "prev" | "next", size: "lg" | "sm") {
    const Icon = kind === "prev" ? SkipBack : SkipForward;
    return (
      <button
        type="button"
        aria-label={kind === "prev" ? "Previous" : "Next"}
        onClick={kind === "prev" ? prev : next}
        disabled={cards.length === 0}
        className={
          "chip inline-flex shrink-0 items-center justify-center rounded-full text-fg " + (size === "lg" ? "size-14" : "size-11")
        }
      >
        <Icon className={(size === "lg" ? "size-5" : "size-4") + " fill-current"} />
      </button>
    );
  }

  function volumeControl() {
    return (
      <div className="chip inline-flex min-h-12 items-center gap-1 rounded-full pr-3 pl-1">
        <button
          type="button"
          aria-label={volumeOff ? "Unmute" : "Mute"}
          aria-pressed={volumeOff}
          aria-keyshortcuts="m"
          title={volumeOff ? "Unmute (M)" : "Mute (M)"}
          onClick={() => setMuted(!volumeOff)}
          className={"inline-flex size-10 items-center justify-center rounded-full " + (volumeOff ? "text-muted" : "text-amber")}
        >
          {volumeOff ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
        <input
          type="range"
          className="nvr-volume w-24 sm:w-28"
          style={{ ["--fill" as string]: `${muted ? 0 : volume}%` }}
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={volume}
          aria-valuetext={muted ? `Muted, ${volume} percent` : `${volume} percent`}
        />
        <span className="w-9 text-right font-mono text-xs tabular-nums text-muted" aria-hidden="true">
          {muted ? "Mute" : `${volume}%`}
        </span>
      </div>
    );
  }

  function downloadButton() {
    return (
      <button
        type="button"
        onClick={() => void downloadCard(index)}
        disabled={!card || downloadingId === card?.id}
        className="chip inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold text-fg"
      >
        {downloadingId && downloadingId === card?.id ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        Download
      </button>
    );
  }

  function seekBar() {
    const count = cardPieces.length;
    const enabled = Boolean(card) && count > 0;
    const fractionAt = (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    };
    const stepTo = (piece: number) => seekCard(bounds[Math.min(count - 1, Math.max(0, piece))] ?? 0);
    const preview = scrubTarget ? cardPieces[scrubTarget.piece] ?? "" : "";
    return (
      <div
        className="nvr-seek"
        role="slider"
        tabIndex={enabled ? 0 : -1}
        aria-label="Position in card"
        aria-disabled={!enabled}
        aria-valuemin={1}
        aria-valuemax={Math.max(1, count)}
        aria-valuenow={enabled ? currentPiece + 1 : 1}
        aria-valuetext={enabled ? `Sentence ${currentPiece + 1} of ${count}` : "Nothing queued"}
        data-scrubbing={scrub !== null ? "true" : undefined}
        title="Drag to move between sentences"
        onPointerDown={(event) => {
          if (!enabled || event.button > 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setScrub(fractionAt(event));
        }}
        onPointerMove={(event) => {
          if (scrub === null) return;
          setScrub(fractionAt(event));
        }}
        onPointerUp={(event) => {
          if (scrub === null) return;
          const f = fractionAt(event);
          setScrub(null);
          seekCard(f);
        }}
        onPointerCancel={() => setScrub(null)}
        onLostPointerCapture={() => setScrub(null)}
        onKeyDown={(event) => {
          if (!enabled) return;
          let piece: number | null = null;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") piece = currentPiece - 1;
          else if (event.key === "ArrowRight" || event.key === "ArrowUp") piece = currentPiece + 1;
          else if (event.key === "Home") piece = 0;
          else if (event.key === "End") piece = count - 1;
          if (piece === null) return;
          // Keep the arrows from also moving between cards.
          event.preventDefault();
          event.stopPropagation();
          stepTo(piece);
        }}
      >
        <div className="nvr-progress">
          <span style={{ width: `${(barFraction * 100).toFixed(2)}%` }} />
          {count > 1 && count <= 80
            ? bounds.slice(1, -1).map((at, i) => (
                <i key={i} className="nvr-tick" style={{ left: `${(at * 100).toFixed(2)}%` }} aria-hidden="true" />
              ))
            : null}
        </div>
        {scrubTarget ? (
          <div
            className="nvr-seek-bubble"
            style={{ left: `clamp(8rem, ${(barFraction * 100).toFixed(2)}%, calc(100% - 8rem))` }}
            aria-hidden="true"
          >
            <span className="font-mono text-[10px] text-amber tabular-nums">
              {scrubTarget.piece + 1} / {count}
            </span>
            <span className="line-clamp-2">{preview}</span>
          </div>
        ) : null}
      </div>
    );
  }

  function readAlong() {
    if (!card) return null;
    if (cardPieces.length === 0) return <p className="nvr-stage-text text-xl leading-snug font-medium text-read sm:text-[1.65rem]">{card.text}</p>;
    return (
      <p className="nvr-stage-text text-xl leading-[1.45] font-medium text-pretty text-read sm:text-[1.65rem]">
        {cardPieces.map((piece, i) => {
          const state = spokenHere == null ? undefined : i < spokenHere ? "done" : i === spokenHere ? "live" : undefined;
          const target = scrubTarget?.piece === i;
          return (
            <span key={i}>
              <span
                className="nvr-sentence"
                data-piece={i}
                data-state={state}
                data-target={target ? "true" : undefined}
                role="button"
                tabIndex={0}
                title="Read from here"
                onClick={() => void playAt(index, i)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    void playAt(index, i);
                  }
                }}
              >
                {piece}
              </span>{" "}
            </span>
          );
        })}
      </p>
    );
  }

  return (
    <>
      <audio ref={audioRef} preload="none" className="hidden" />
      <Toaster theme={resolvedTheme} position="bottom-center" richColors={false} toastOptions={{ className: "glass-strong" }} />
      <div className="nvr-aurora" aria-hidden="true">
        <div className="nvr-aurora-grid" />
        <div className="nvr-aurora-noise" />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        multiple
        className="hidden"
        onChange={(event) => {
          void addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div className="nvr-shell" data-settings={settingsOpen ? "open" : "collapsed"} data-focus={focusMode ? "true" : undefined}>
        <button
          type="button"
          className="nvr-backdrop"
          aria-label="Close settings"
          tabIndex={settingsOpen && !wide ? 0 : -1}
          onClick={() => setSettingsOpen(false)}
        />

        <section className="nvr-main flex min-w-0 flex-col gap-5 px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pt-7">
          <header className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="btn-accent relative inline-flex size-11 shrink-0 items-center justify-center rounded-2xl" aria-hidden="true">
                  <AudioLines className="size-5" />
                </span>
                <h1 className="min-w-0 text-2xl leading-none font-semibold tracking-tight text-fg sm:text-[1.75rem]">
                  Natural <span className="text-gradient font-display text-[1.15em] font-normal italic">Voice</span> Reader
                </h1>
              </div>
              <div className="nvr-hide-in-focus order-last flex w-full flex-wrap items-center gap-2 md:order-none md:w-auto">
                <div className="seg" role="group" aria-label="Appearance">
                  {themeButton("light", "Light", Sun)}
                  {themeButton("dark", "Dark", Moon)}
                  {themeButton("system", "System", Monitor)}
                </div>
                <div className="chip flex items-center gap-1 rounded-full p-1" role="group" aria-label="Accent color">
                  {inks.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-label={`${item.label} accent`}
                      aria-pressed={ink === item.id}
                      title={item.label}
                      onClick={() => setInk(item.id)}
                      className="inline-flex size-9 items-center justify-center rounded-full"
                    >
                      <span
                        className={
                          `size-5 rounded-full swatch-${item.id} transition-transform ` +
                          (ink === item.id ? "scale-110 ring-2 ring-fg ring-offset-2 ring-offset-bg" : "opacity-80")
                        }
                      />
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setShowKeys(true)}
                  aria-label="Keyboard shortcuts"
                  aria-keyshortcuts="?"
                  title="Keyboard shortcuts (?)"
                  className="chip hidden size-11 items-center justify-center rounded-full text-fg sm:inline-flex"
                >
                  <Keyboard className="size-4" />
                </button>
              </div>
              {settingsToggle()}
            </div>
            <p className="nvr-hide-in-focus max-w-2xl text-sm leading-relaxed text-muted">
              Choose the Audio voice and read along, and/or download the audio file. (browsers may have limited voice options)
            </p>
          </header>

          <article
            ref={stageRef}
            aria-label="Now reading"
            className="nvr-stage glass relative flex min-h-[26rem] flex-col overflow-hidden rounded-[2rem] p-5 sm:p-8"
          >
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-60"
              style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, var(--color-amber) 14%, transparent), transparent)" }}
              aria-hidden="true"
            />
            <div className="relative flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="rounded-full bg-amber-soft px-3 py-1 font-mono text-xs font-semibold tracking-wide text-amber tabular-nums">
                  {cards.length === 0 ? "EMPTY" : `${String(index + 1).padStart(2, "0")} / ${String(cards.length).padStart(2, "0")}`}
                </span>
                <span className="sr-only">{countLabel}</span>
                <span className="flex min-w-0 items-center gap-2 text-muted">
                  <span className="nvr-eq" data-paused={phase !== "playing"} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="truncate font-medium text-fg">
                    {auditionId ? `Hearing ${voiceById(auditionId).name}` : speaking.name}
                  </span>
                  {rotate && voiceId !== "device" && !auditionId ? <span className="hidden sm:inline">· switches each post</span> : null}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {card ? (
                  <span className="hidden font-mono text-xs text-muted tabular-nums sm:inline" title="Estimated listening time left in the queue">
                    {formatDuration(leftInQueue)} left
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setFocusMode(!focusMode)}
                  aria-pressed={focusMode}
                  aria-keyshortcuts="f"
                  aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
                  title={focusMode ? "Exit focus mode (F)" : "Focus mode (F)"}
                  className="chip inline-flex size-10 items-center justify-center rounded-full text-fg"
                >
                  {focusMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </button>
              </div>
            </div>

            <VoiceVisualizer
              analyser={deviceSpeaking ? null : analyser}
              active={phase === "playing"}
              className="relative mt-5 h-16 w-full sm:h-20"
            />

            <div className="relative mt-5 flex flex-1 flex-col">
              {card ? (
                <>
                  {readAlong()}
                  <p className="nvr-hide-in-focus mt-4 text-xs text-muted">Tap any sentence to read from there.</p>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
                  <span className="relative inline-flex size-20 items-center justify-center rounded-full bg-amber-soft text-amber">
                    <AudioWaveform className="size-9" />
                  </span>
                  <p className="text-2xl font-semibold tracking-tight text-fg">Nothing queued.</p>
                  <p className="max-w-sm text-sm leading-relaxed text-muted">
                    Paste text, or load a short sample to hear the voices. You can also drop a .txt or .md file here.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => loadSamples("replace")}
                      className="btn-accent inline-flex min-h-12 items-center gap-2 rounded-full px-5 text-sm font-semibold"
                    >
                      <Sparkles className="size-4" />
                      Load sample text
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="chip inline-flex min-h-12 items-center gap-2 rounded-full px-5 text-sm font-semibold text-fg"
                    >
                      <FileText className="size-4" />
                      Open a file
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="relative mt-5 flex flex-col gap-1">
              {seekBar()}
              <div className="flex justify-between font-mono text-[11px] text-muted tabular-nums">
                <span>{formatDuration(cardSeconds - leftOnCard)}</span>
                <span>−{formatDuration(leftOnCard)}</span>
              </div>
            </div>

            <div className="relative mt-4 flex flex-col items-center gap-5" aria-label="Playback">
              <div className="flex items-center gap-4 sm:gap-6">
                {skipButton("prev", "lg")}
                {playButton("lg")}
                {skipButton("next", "lg")}
              </div>
              <div className="nvr-hide-in-focus flex flex-wrap items-center justify-center gap-2">
                {voicePicker(true)}
                {downloadButton()}
                {volumeControl()}
              </div>
            </div>

            <div className="relative mt-4 flex flex-col gap-1 text-center">
              {ttsStatus && !note ? (
                <p
                  className={
                    "text-xs " + (ttsStatus.state === "loading" || ttsStatus.state === "downloading" ? "text-fg" : "text-muted")
                  }
                  role="status"
                >
                  {ttsStatus.state === "loading" || ttsStatus.state === "downloading" ? (
                    <Loader2 className="mr-1.5 inline size-3 animate-spin align-[-2px]" />
                  ) : (
                    <span className="mr-1.5 inline-block size-1.5 rounded-full bg-amber align-middle" aria-hidden="true" />
                  )}
                  {ttsStatus.download?.percent != null
                    ? `${ttsStatus.message} (${Math.round(ttsStatus.download.percent)}%)`
                    : ttsStatus.message}
                </p>
              ) : null}
              {error || google.error ? (
                <p className="text-sm text-danger" role="alert">
                  {error || google.error}
                </p>
              ) : null}
              {note || google.note ? <p className="text-xs text-muted">{note || google.note}</p> : null}
            </div>
          </article>

          <div className="nvr-hide-in-focus glass flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] p-3">
            <div className="seg" role="group" aria-label="Speed" aria-keyshortcuts="[ ]">
              {SPEED_OPTIONS.map((opt) => (
                <button key={opt.label} type="button" onClick={() => setSpeed(opt.value)} aria-pressed={speed === opt.value}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="When a card ends">
              {PLAY_MODE_OPTIONS.map((opt) => (
                <button key={opt.value} type="button" onClick={() => setPlayMode(opt.value)} aria-pressed={playMode === opt.value} title={opt.hint}>
                  <opt.icon className="size-4" />
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSoftRoom(!softRoom)}
              aria-pressed={softRoom}
              title="A light room tone on playback only. Downloads stay dry."
              className={
                "inline-flex min-h-11 items-center gap-2.5 rounded-full border px-3 text-sm font-semibold transition-colors " +
                (softRoom ? "border-amber bg-amber-soft text-amber" : "chip text-muted")
              }
            >
              <span
                className={
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (softRoom ? "bg-amber" : "bg-track/50")
                }
                aria-hidden="true"
              >
                <span
                  className={
                    "absolute size-4 rounded-full bg-fg shadow transition-transform " + (softRoom ? "translate-x-[18px] bg-ink" : "translate-x-0.5")
                  }
                />
              </span>
              <Waves className="size-4" />
              Soft room
            </button>
          </div>

          <p className="nvr-hide-in-focus px-1 text-xs leading-relaxed text-muted">
            {isDesktopApp()
              ? "Generated voices run on this device once a voice pack is installed in Settings: KittenTTS for the standard voices, Kokoro for Butler and the Indian English voices. Without a pack, the device voice is used. The first sentence starts as soon as it is ready."
              : "Generated voices come from local VoiceStudio on port 3900, from the Kokoro helper on port 3901 for Butler and the Indian English voices, then from xAI if a key is set. Otherwise the browser device voice is used and every named voice will sound the same. The first sentence starts as soon as it is ready."}
          </p>

          <section className="nvr-hide-in-focus glass flex flex-col gap-3 rounded-[1.5rem] p-4 sm:p-5" aria-labelledby="nvr-queue-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <h2 id="nvr-queue-title" className="text-sm font-semibold tracking-[0.08em] text-fg uppercase">
                  Queue
                </h2>
                <span className="font-mono text-xs text-muted tabular-nums">
                  {cards.length} {cards.length === 1 ? "card" : "cards"}
                  {cards.length ? ` · ${formatDuration(secondsToRead(cards.reduce((sum, item) => sum + wordCount(item.text), 0), speed))}` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={askClearQueue}
                  disabled={cards.length === 0}
                  className="inline-flex min-h-10 items-center gap-2 rounded-full border border-danger/60 px-3 text-xs font-semibold text-danger hover:bg-danger/10"
                >
                  <Trash2 className="size-4" />
                  Clear queue
                </button>
                <button
                  type="button"
                  onClick={askResetSettings}
                  className="chip inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-xs font-semibold text-fg"
                >
                  <RotateCcw className="size-4" />
                  Reset to defaults
                </button>
              </div>
            </div>
            {cards.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                Your queue is empty. Add a card below.
              </p>
            ) : (
              <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1">
                {cards.map((item, i) => {
                  const active = i === index;
                  const v = voiceForCardIn(installedVoices, i, voiceId, rotate);
                  return (
                    <li key={item.id} className="flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setIndex(i);
                          void playAt(i);
                        }}
                        data-active={active ? "true" : undefined}
                        className="nvr-row chip flex min-h-14 flex-1 items-start gap-3 rounded-2xl px-3 py-2.5 text-left"
                      >
                        <span
                          className={
                            "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold tabular-nums " +
                            (active ? "bg-amber text-ink" : "bg-raise text-muted")
                          }
                        >
                          {active && phase === "playing" ? (
                            <span className="nvr-eq" aria-hidden="true" style={{ height: 10 }}>
                              <i style={{ background: "currentColor" }} />
                              <i style={{ background: "currentColor" }} />
                              <i style={{ background: "currentColor" }} />
                            </span>
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-xs font-semibold text-amber">
                            <span className="sr-only">{i + 1} · </span>
                            {v.name}
                            <span className="font-mono font-normal text-muted tabular-nums">
                              {formatDuration(secondsToRead(wordCount(item.text), speed))}
                            </span>
                          </span>
                          <span className="mt-1 line-clamp-2 text-sm leading-snug text-read">{item.text}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Download card ${i + 1}`}
                        onClick={() => void downloadCard(i)}
                        disabled={downloadingId === item.id}
                        className="chip inline-flex w-11 items-center justify-center rounded-2xl text-fg"
                      >
                        {downloadingId === item.id ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove card ${i + 1}`}
                        onClick={() => removeCard(item.id)}
                        className="chip inline-flex w-11 items-center justify-center rounded-2xl text-muted hover:text-danger"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <form
            className="nvr-hide-in-focus glass flex flex-col gap-3 rounded-[1.5rem] p-4 sm:p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (source === "link") void commitPage("append");
              else commitPaste("append");
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold tracking-[0.08em] text-fg uppercase">Add</h2>
              <div className="seg" role="group" aria-label="What to add">
                <button
                  type="button"
                  onClick={() => {
                    setSource("card");
                    setComposerNote(null);
                  }}
                  aria-pressed={source === "card"}
                >
                  <Plus className="size-3.5" />
                  Card
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSource("link");
                    setComposerNote(null);
                  }}
                  aria-pressed={source === "link"}
                >
                  <Link2 className="size-3.5" />
                  Link
                </button>
              </div>
            </div>
            {source === "card" ? (
              <div className="relative">
                <textarea
                  id="paste"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setComposerNote(null);
                  }}
                  rows={5}
                  placeholder="Paste a post or a page. A blank line starts a new card. Each card can be up to 5,000 characters."
                  className="w-full resize-y rounded-2xl border border-line bg-bg/50 px-4 py-3 text-sm leading-relaxed text-fg outline-none placeholder:text-muted focus:border-amber focus:ring-4 focus:ring-amber/15"
                />
                {draft ? (
                  <span className="pointer-events-none absolute right-3 bottom-3 font-mono text-[11px] text-muted tabular-nums">
                    {wordCount(draft)} words · {formatDuration(secondsToRead(wordCount(draft), speed))}
                  </span>
                ) : null}
              </div>
            ) : (
              <>
                <input
                  id="page-url"
                  type="url"
                  inputMode="url"
                  value={pageUrl}
                  onChange={(e) => {
                    setPageUrl(e.target.value);
                    setComposerNote(null);
                  }}
                  placeholder="https://example.com/article"
                  className="min-h-12 w-full rounded-2xl border border-line bg-bg/50 px-4 text-sm text-fg outline-none placeholder:text-muted focus:border-amber focus:ring-4 focus:ring-amber/15"
                />
                <p className="text-xs leading-relaxed text-muted">A page is queued in pieces of about 2,000 characters, split on a word.</p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {google.addFromDriveButton}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="chip inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-fg"
              >
                <FileText className="size-4" />
                Open file
              </button>
              <button
                type="submit"
                disabled={reading}
                className="btn-accent inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold"
              >
                {reading ? <Loader2 className="size-4 animate-spin" /> : source === "link" ? <Link2 className="size-4" /> : <Plus className="size-4" />}
                {reading ? "Reading page" : source === "link" ? "Read page" : "Add to lane"}
              </button>
              <button
                type="button"
                disabled={reading}
                onClick={() => (source === "link" ? void commitPage("replace") : commitPaste("replace"))}
                className="chip inline-flex min-h-12 items-center justify-center rounded-full px-4 text-sm font-semibold text-fg"
              >
                Replace
              </button>
            </div>
            {composerNote ? <p className="text-xs text-muted">{composerNote}</p> : null}
          </form>
        </section>

        <aside
          className="nvr-aside lg:border-l lg:border-line/60"
          aria-label="Settings"
          aria-hidden={!settingsOpen && wide ? true : undefined}
        >
          <div className="nvr-aside-inner flex min-h-full flex-col gap-6 px-4 py-6 pb-safe sm:px-6 lg:sticky lg:top-0 lg:max-h-dvh lg:overflow-y-auto lg:px-5 lg:py-7">
            <div className="flex items-center justify-between gap-3 lg:hidden">
              <h2 className="text-sm font-semibold tracking-[0.08em] text-fg uppercase">Settings</h2>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
                className="chip inline-flex size-11 items-center justify-center rounded-full text-fg"
              >
                <PanelRightClose className="size-4" />
              </button>
            </div>
            {google.accountCard}
            {packs ? <VoicePackSettings packs={packs} onChange={setPacks} /> : null}
            <div className="glass flex flex-col gap-3 rounded-[1.5rem] p-4">
              {isDesktopApp() ? null : (
                <div className="flex flex-col gap-2">
                  <h2 className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">Engine</h2>
                  <div className="seg w-full" role="group" aria-label="Local voice engine">
                    {TTS_MODELS.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => setTtsModel(model.id)}
                        aria-pressed={ttsModel === model.id}
                        disabled={!availableEngines.includes(model.id)}
                        title={!availableEngines.includes(model.id) ? "Install the OmniVoice pack in Settings to use this engine." : model.note}
                        className="flex-1"
                      >
                        {model.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">Voices</h2>
                <div className="seg w-full" role="group" aria-label="Voice mode">
                  <button type="button" onClick={() => setRotate(false)} aria-pressed={!rotate} className="flex-1">
                    One voice
                  </button>
                  <button type="button" onClick={() => setRotate(true)} aria-pressed={rotate} className="flex-1">
                    <Shuffle className="size-3.5" />
                    Switch each post
                  </button>
                </div>
              </div>
              {voicePicker(false)}
            </div>

            <p className="mt-auto font-mono text-[11px] text-muted">{APP_VERSION_LABEL}</p>
          </div>
        </aside>
      </div>

      <div className="nvr-mini" data-show={showMini ? "true" : "false"} aria-hidden={!showMini} inert={!showMini}>
        <div className="glass-strong flex items-center gap-3 overflow-hidden rounded-full py-2 pr-2 pl-2 sm:pl-3" aria-label="Mini player">
          {skipButton("prev", "sm")}
          {playButton("sm")}
          {skipButton("next", "sm")}
          <button
            type="button"
            onClick={() => stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex min-w-0 flex-1 flex-col text-left"
            aria-label="Back to the reader"
          >
            <span className="truncate text-sm font-semibold text-fg">
              {card && spokenHere != null ? cardPieces[spokenHere] ?? card.text : card?.text ?? ""}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted">
              <span className="font-mono tabular-nums text-amber">{countLabel}</span>
              <span className="truncate">{speaking.name}</span>
            </span>
            <span className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-fg/10">
              <span className="block h-full rounded-full bg-amber" style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          </button>
        </div>
      </div>

      {dragging ? (
        <div className="nvr-drop" aria-hidden="true">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="btn-accent inline-flex size-16 items-center justify-center rounded-2xl">
              <FileText className="size-7" />
            </span>
            <p className="text-xl font-semibold text-fg">Drop to add to the queue</p>
            <p className="text-sm text-muted">Plain text and Markdown files</p>
          </div>
        </div>
      ) : null}

      {showKeys ? (
        <div className="nvr-dialog-root" role="presentation">
          <button type="button" className="nvr-dialog-backdrop" aria-label="Close" onClick={() => setShowKeys(false)} />
          <div className="nvr-dialog" role="dialog" aria-modal="true" aria-labelledby="nvr-keys-title" style={{ width: "min(26rem, 100%)" }}>
            <div className="flex items-center justify-between gap-3">
              <h2 id="nvr-keys-title" className="text-base font-semibold text-fg">
                Keyboard shortcuts
              </h2>
              <button type="button" aria-label="Close" onClick={() => setShowKeys(false)} className="inline-flex size-10 items-center justify-center rounded-full text-muted">
                <X className="size-5" />
              </button>
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-sm">
              {(
                [
                  [["Space"], "Play or pause"],
                  [["←", "→"], "Previous or next card"],
                  [["[", "]"], "Slower or faster"],
                  [["M"], "Mute or unmute"],
                  [["F"], "Focus mode"],
                  [[","], "Show or hide settings"],
                  [["?"], "This list"],
                  [["Esc"], "Close"],
                ] as const
              ).map(([keys, label]) => (
                <div key={label} className="contents">
                  <dt className="flex gap-1">
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd className="text-muted">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}

      {google.dialogs}
      {confirmAction ? (
        <div className="nvr-dialog-root" role="presentation">
          <button type="button" className="nvr-dialog-backdrop" aria-label="Cancel" onClick={() => setConfirmAction(null)} />
          <div className="nvr-dialog" role="alertdialog" aria-modal="true" aria-labelledby="nvr-confirm-title">
            {confirmAction === "clear" ? (
              <>
                <h2 id="nvr-confirm-title" className="text-base font-semibold text-fg">
                  Clear the queue?
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  This removes every card from the queue. Installed voice packs and your settings stay as they are. You can undo this.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirmAction(null)} className="chip inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold text-fg">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={runClearQueue}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full border border-danger bg-danger/10 px-4 text-sm font-semibold text-danger"
                  >
                    <Trash2 className="size-4" />
                    Clear queue
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="nvr-confirm-title" className="text-base font-semibold text-fg">
                  Reset settings to defaults?
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  This restores the voice, speed, volume, engine, and settings panel to their defaults. The queue and installed voice packs are not changed. You can undo this.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirmAction(null)} className="chip inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold text-fg">
                    Cancel
                  </button>
                  <button type="button" onClick={runResetSettings} className="btn-accent inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold">
                    <RotateCcw className="size-4" />
                    Reset to defaults
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
