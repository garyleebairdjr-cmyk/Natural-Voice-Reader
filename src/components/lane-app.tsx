import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
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
import { readPage } from "@/lib/platform";
import { defaultInk, inksFor, inkFits, migrateInk, resolveTheme, type ThemeName } from "@/lib/appearance";
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
import { applyPlayback } from "@/lib/soft-room";
import { joinClips } from "@/lib/audio-join";
import { listVoicePacks } from "@/lib/platform";
import { voicesInInstalledPacks, type VoicePackStatus } from "@/lib/voice-packs";
import { VoicePackSettings } from "@/components/voice-pack-settings";
import { VoicePicker } from "@/components/voice-picker";
import { useGoogleSession } from "@/components/google-session";
import { VOICE_PREVIEW_LINE } from "@/lib/voice-picker";

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
  const pieceRef = useRef({ index: 0, count: 1 });

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
    if (meta) meta.setAttribute("content", resolvedTheme === "light" ? "#f3eee4" : "#14161c");
  }, [appearanceReady, theme, ink, resolvedTheme, setInk]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const d = audio.duration;
      const within = d && Number.isFinite(d) ? audio.currentTime / d : 0;
      if (modeRef.current === "lane") {
        const { index: piece, count } = pieceRef.current;
        setProgress(Math.min(1, (piece + within) / Math.max(1, count)));
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

  function playDevice(text: string, token: number, rate: number) {
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
        setProgress(Math.min(1, event.charIndex / text.length));
      };
      const clearKeep = () => {
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

  async function playGeneratedPieces(pieces: string[], voice: string, token: number, startAt: number) {
    const audio = audioRef.current;
    if (!audio) return;
    pieceRef.current.count = pieces.length;
    for (let i = startAt; i < pieces.length; i++) {
      if (token !== gen.current || modeRef.current !== "lane") return;
      pieceRef.current.index = i;
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
      setProgress((i + (audio.currentTime && audio.duration ? audio.currentTime / audio.duration : 0)) / pieces.length);
      await waitForAudioEnd(token);
    }
  }

  async function playAt(nextIndex: number) {
    const state = useLane.getState();
    const nextCard = state.cards[nextIndex];
    if (!nextCard) {
      setPhase("idle");
      return;
    }
    const token = ++gen.current;
    endedWaiter.current = null;
    stopDevice();
    state.setIndex(nextIndex);
    const voice = voiceForCardIn(installedVoices, nextIndex, state.voiceId, state.rotate);
    setPhase("loading");
    setError(null);
    setNote(null);
    setAuditionId(null);
    pieceRef.current = { index: 0, count: 1 };
    modeRef.current = "lane";

    const markPlaying = () => {
      playingId.current = nextCard.id;
      setPhase("playing");
      void holdScreen();
      publishSession(nextCard.text, voice.name, true);
    };

    try {
      if (voice.id === "device") {
        markPlaying();
        await playDevice(nextCard.text, token, useLane.getState().speed);
        if (token !== gen.current || modeRef.current !== "lane") return;
        advanceRef.current(nextIndex);
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const pieces = splitForStreaming(nextCard.text);
      if (pieces.length === 0) {
        setPhase("idle");
        return;
      }
      pieceRef.current = { index: 0, count: pieces.length };
      const first = await ensureAudio(pieces[0]!, voice.id, ac.signal);
      if (token !== gen.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      speedAppliedRef.current = first.speedApplied;
      audio.src = first.url;
      loadedKey.current = first.key;
      audio.playbackRate = first.speedApplied ? 1 : useLane.getState().speed;
      prefetchUpcoming(pieces, 0, nextIndex, voice.id);
      applyPlayback(audio, { softRoom: useLane.getState().softRoom, gain: effectiveGain(useLane.getState().volume, useLane.getState().muted) });
      await audio.play();
      if (token !== gen.current) {
        audio.pause();
        return;
      }
      markPlaying();
      await waitForAudioEnd(token);
      if (token !== gen.current || modeRef.current !== "lane") return;
      if (pieces.length > 1) {
        await playGeneratedPieces(pieces, voice.id, token, 1);
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
          await playDevice(nextCard.text, token, useLane.getState().speed);
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
    const current = state.cards[state.index];
    const voice = current ? voiceForCardIn(installedVoices, state.index, state.voiceId, state.rotate) : null;
    const key = current && voice
      ? audioCacheKey(voice.id, splitForStreaming(current.text)[0] ?? current.text, state.ttsModel, state.speed)
      : null;
    const audio = audioRef.current;
    if (
      phaseRef.current === "paused" &&
      audio &&
      key &&
      loadedKey.current === key &&
      playingId.current === current?.id &&
      !audio.ended
    ) {
      audio.playbackRate = speedAppliedRef.current ? 1 : state.speed;
      applyPlayback(audio, { softRoom: useLane.getState().softRoom, gain: effectiveGain(useLane.getState().volume, useLane.getState().muted) });
      void audio.play().then(() => {
        setPhase("playing");
        void holdScreen();
        if (current && voice) publishSession(current.text, voice.name, true);
      });
      return;
    }
    void playAt(state.index);
  }
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

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
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-fg"
      >
        {settingsOpen ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
        {settingsOpen ? "Hide settings" : "Settings"}
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

  function transportBar(label: string) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3" aria-label={label}>
        <button
          type="button"
          aria-label="Previous"
          onClick={prev}
          disabled={cards.length === 0}
          className="inline-flex size-14 items-center justify-center rounded-full border border-line bg-surface text-fg disabled:opacity-55"
        >
          <SkipBack className="size-6" />
        </button>
        <button
          type="button"
          aria-label={phase === "playing" || phase === "loading" ? "Pause" : "Play"}
          onClick={toggle}
          disabled={cards.length === 0}
          className="inline-flex size-20 items-center justify-center rounded-full bg-amber text-ink disabled:opacity-55"
        >
          {phase === "loading" ? (
            <Loader2 className="size-8 animate-spin" />
          ) : phase === "playing" ? (
            <Pause className="size-8" />
          ) : (
            <Play className="size-8 translate-x-0.5" />
          )}
        </button>
        <button
          type="button"
          aria-label="Next"
          onClick={next}
          disabled={cards.length === 0}
          className="inline-flex size-14 items-center justify-center rounded-full border border-line bg-surface text-fg disabled:opacity-55"
        >
          <SkipForward className="size-6" />
        </button>
        {voicePicker(true)}
        <button
          type="button"
          onClick={() => void downloadCard(index)}
          disabled={!card || downloadingId === card?.id}
          className="inline-flex min-h-12 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-fg disabled:opacity-55"
        >
          {downloadingId && downloadingId === card?.id ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Download
        </button>
        <div className="inline-flex min-h-12 items-center gap-2 rounded-full border border-line bg-surface px-2">
          <button
            type="button"
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            aria-pressed={muted || volume === 0}
            title={muted || volume === 0 ? "Unmute" : "Mute"}
            onClick={() => setMuted(!(muted || volume === 0))}
            className={
              "inline-flex size-11 items-center justify-center rounded-full " +
              (muted || volume === 0 ? "text-muted" : "text-amber")
            }
          >
            {muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>
          <input
            type="range"
            className="nvr-volume w-24 sm:w-28"
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
          <span className="w-9 pr-1 text-xs font-semibold tabular-nums text-muted" aria-hidden="true">
            {muted ? "Mute" : `${volume}%`}
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <audio ref={audioRef} preload="none" className="hidden" />
      <Toaster theme={resolvedTheme} position="bottom-center" richColors={false} />
      <div className="nvr-shell" data-settings={settingsOpen ? "open" : "collapsed"}>
      <button
        type="button"
        className="nvr-backdrop"
        aria-label="Close settings"
        tabIndex={settingsOpen && !wide ? 0 : -1}
        onClick={() => setSettingsOpen(false)}
      />

      <section className="nvr-main flex min-w-0 flex-col gap-5 px-4 pt-5 pb-safe sm:px-6 lg:px-8 lg:pt-8 lg:pb-8">
        <header className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 flex-1 font-display text-3xl leading-tight font-semibold text-balance text-fg sm:text-4xl">
              Natural Voice Reader
            </h1>
            {settingsToggle()}
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            Choose the Audio voice and read along, and/or download the audio file. (browsers may have limited
            voice options)
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Appearance">
              <button
                type="button"
                onClick={() => chooseTheme("light")}
                aria-pressed={theme === "light"}
                className={
                  "inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold " +
                  (theme === "light" ? "bg-amber text-ink" : "text-muted")
                }
              >
                <Sun className="size-4" />
                Light
              </button>
              <button
                type="button"
                onClick={() => chooseTheme("dark")}
                aria-pressed={theme === "dark"}
                className={
                  "inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold " +
                  (theme === "dark" ? "bg-amber text-ink" : "text-muted")
                }
              >
                <Moon className="size-4" />
                Dark
              </button>
              <button
                type="button"
                onClick={() => chooseTheme("system")}
                aria-pressed={theme === "system"}
                className={
                  "inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold " +
                  (theme === "system" ? "bg-amber text-ink" : "text-muted")
                }
              >
                <Monitor className="size-4" />
                System
              </button>
            </div>
            <div className="flex items-center gap-2" role="group" aria-label="Accent color">
              {inks.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`${item.label} accent`}
                  aria-pressed={ink === item.id}
                  onClick={() => setInk(item.id)}
                  className={
                    "inline-flex size-11 items-center justify-center rounded-full border " +
                    (ink === item.id ? "border-amber" : "border-line")
                  }
                >
                  <span className={`size-6 rounded-full swatch-${item.id}`} />
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="sticky top-0 z-10 -mx-4 bg-bg px-4 py-3 sm:-mx-6 sm:px-6">
          {transportBar("Top playback")}
        </div>

        <article className="flex min-h-72 flex-1 flex-col rounded-card border border-line bg-surface p-4 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-amber tabular-nums">{countLabel}</span>
            <span className="truncate text-muted">
              {auditionId ? `Hearing ${voiceById(auditionId).name}` : speaking.name}
              {rotate && voiceId !== "device" && !auditionId ? " · switches each post" : ""}
            </span>
          </div>

          <div className="mb-4 h-1 overflow-hidden rounded-full bg-raise">
            <div
              className="h-full bg-amber"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>

          {card ? (
            <p className="flex-1 text-xl leading-snug font-medium text-pretty text-read sm:text-2xl">{card.text}</p>
          ) : (
            <div className="flex flex-1 flex-col items-start justify-center gap-4">
              <p className="text-xl leading-snug font-medium text-fg">Nothing queued.</p>
              <p className="max-w-sm text-sm leading-relaxed text-muted">
                Paste text, or load a short sample to hear the voices.
              </p>
              <button
                type="button"
                onClick={() => loadSamples("replace")}
                className="inline-flex min-h-12 items-center rounded-full bg-amber px-5 text-sm font-semibold text-ink"
              >
                Load sample text
              </button>
            </div>
          )}

          {ttsStatus && !note ? (
            <p
              className={
                "mt-3 text-sm " +
                (ttsStatus.state === "loading" || ttsStatus.state === "downloading" ? "text-fg" : "text-muted")
              }
              role="status"
            >
              {ttsStatus.download?.percent != null
                ? `${ttsStatus.message} (${Math.round(ttsStatus.download.percent)}%)`
                : ttsStatus.message}
            </p>
          ) : null}
          {(error || google.error) ? (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error || google.error}
            </p>
          ) : null}
          {(note || google.note) ? <p className="mt-3 text-sm text-muted">{note || google.note}</p> : null}
        </article>

        {transportBar("Bottom playback")}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Speed">
            {SPEED_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setSpeed(opt.value)}
                aria-pressed={speed === opt.value}
                className={
                  "min-h-11 rounded-full px-3 text-sm font-semibold " +
                  (speed === opt.value ? "bg-amber text-ink" : "text-muted")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="When a card ends">
            {PLAY_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPlayMode(opt.value)}
                aria-pressed={playMode === opt.value}
                title={opt.hint}
                className={
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold " +
                  (playMode === opt.value ? "bg-amber text-ink" : "text-muted")
                }
              >
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
              "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold " +
              (softRoom ? "border-amber bg-raise text-amber" : "border-line bg-surface text-muted")
            }
          >
            Soft room
          </button>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          {isDesktopApp()
            ? "Generated voices run on this device once a voice pack is installed in Settings: KittenTTS for the standard voices, Kokoro for Butler and the Indian English voices. Without a pack, the device voice is used. The first sentence starts as soon as it is ready."
            : "Generated voices come from local VoiceStudio on port 3900, from the Kokoro helper on port 3901 for Butler and the Indian English voices, then from xAI if a key is set. Otherwise the browser device voice is used and every named voice will sound the same. The first sentence starts as soon as it is ready."}
        </p>
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Queue</h2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={askClearQueue}
                disabled={cards.length === 0}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-danger px-3 text-xs font-semibold text-danger disabled:opacity-55"
              >
                <Trash2 className="size-4" />
                Clear queue
              </button>
              <button
                type="button"
                onClick={askResetSettings}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs font-semibold text-fg"
              >
                <RotateCcw className="size-4" />
                Reset to defaults
              </button>
            </div>
          </div>
          <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto lg:max-h-none">
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
                    className={
                      "min-h-14 flex-1 rounded-2xl border px-3 py-2 text-left " +
                      (active ? "border-amber bg-amber-soft" : "border-line bg-surface")
                    }
                  >
                    <span className="block text-xs font-semibold text-amber tabular-nums">
                      {i + 1} · {v.name}
                    </span>
                    <span className="mt-1 line-clamp-2 text-sm leading-snug text-read">{item.text}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Download card ${i + 1}`}
                    onClick={() => void downloadCard(i)}
                    disabled={downloadingId === item.id}
                    className="inline-flex w-11 items-center justify-center rounded-2xl border border-line text-fg disabled:opacity-55"
                  >
                    {downloadingId === item.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Download className="size-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove card ${i + 1}`}
                    onClick={() => removeCard(item.id)}
                    className="inline-flex w-11 items-center justify-center rounded-2xl border border-line text-muted"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (source === "link") void commitPage("append");
            else commitPaste("append");
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Add</h2>
            <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="What to add">
              <button
                type="button"
                onClick={() => {
                  setSource("card");
                  setComposerNote(null);
                }}
                aria-pressed={source === "card"}
                className={
                  "min-h-11 rounded-full px-3 text-xs font-semibold " +
                  (source === "card" ? "bg-amber text-ink" : "text-muted")
                }
              >
                Card
              </button>
              <button
                type="button"
                onClick={() => {
                  setSource("link");
                  setComposerNote(null);
                }}
                aria-pressed={source === "link"}
                className={
                  "inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-semibold " +
                  (source === "link" ? "bg-amber text-ink" : "text-muted")
                }
              >
                <Link2 className="size-3.5" />
                Link
              </button>
            </div>
          </div>
          {source === "card" ? (
            <textarea
              id="paste"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setComposerNote(null);
              }}
              rows={5}
              placeholder="Paste a post or a page. A blank line starts a new card. Each card can be up to 5,000 characters."
              className="w-full resize-y rounded-2xl border border-line bg-surface px-3 py-3 text-sm leading-relaxed text-fg outline-none placeholder:text-muted focus:border-amber"
            />
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
                className="min-h-12 w-full rounded-2xl border border-line bg-surface px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-amber"
              />
              <p className="text-xs leading-relaxed text-muted">
                A page is queued in pieces of about 2,000 characters, split on a word.
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {google.addFromDriveButton}
            <button
              type="submit"
              disabled={reading}
              className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-amber px-4 text-sm font-semibold text-ink disabled:opacity-55"
            >
              {reading ? <Loader2 className="size-4 animate-spin" /> : source === "link" ? <Link2 className="size-4" /> : <Plus className="size-4" />}
              {reading ? "Reading page" : source === "link" ? "Read page" : "Add to lane"}
            </button>
            <button
              type="button"
              disabled={reading}
              onClick={() => (source === "link" ? void commitPage("replace") : commitPaste("replace"))}
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-line px-4 text-sm font-semibold text-fg disabled:opacity-55"
            >
              Replace
            </button>
          </div>
          {composerNote ? <p className="text-xs text-muted">{composerNote}</p> : null}
        </form>
      </section>

      <aside className="nvr-aside border-line lg:border-l" aria-label="Settings" aria-hidden={!settingsOpen && wide ? true : undefined}>
        <div className="nvr-aside-inner flex min-h-full flex-col gap-6 px-4 py-6 pb-safe sm:px-6 lg:max-h-dvh lg:overflow-y-auto lg:px-5 lg:py-8">
        <div className="flex items-center justify-between gap-3 lg:hidden">
          <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Settings</h2>
          <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings" className="inline-flex size-11 items-center justify-center rounded-full border border-line text-fg">
            <PanelRightClose className="size-4" />
          </button>
        </div>
        {google.accountCard}
        {packs ? <VoicePackSettings packs={packs} onChange={setPacks} /> : null}
        <div>
          <div className="mb-3 flex flex-col gap-3">
            {isDesktopApp() ? null : <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Engine</h2>
              <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Local voice engine">
                {TTS_MODELS.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setTtsModel(model.id)}
                    aria-pressed={ttsModel === model.id}
                    disabled={!availableEngines.includes(model.id)}
                    title={!availableEngines.includes(model.id) ? "Install the OmniVoice pack in Settings to use this engine." : model.note}
                    className={
                      "min-h-11 rounded-full px-3 text-xs font-semibold " +
                      (ttsModel === model.id ? "bg-amber text-ink" : "text-muted")
                    }
                  >
                    {model.label}
                  </button>
                ))}
              </div>
            </div>}
            <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Voices</h2>
            <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Voice mode">
              <button
                type="button"
                onClick={() => setRotate(false)}
                aria-pressed={!rotate}
                className={
                  "min-h-11 rounded-full px-3 text-xs font-semibold " +
                  (!rotate ? "bg-amber text-ink" : "text-muted")
                }
              >
                One voice
              </button>
              <button
                type="button"
                onClick={() => setRotate(true)}
                aria-pressed={rotate}
                className={
                  "min-h-11 rounded-full px-3 text-xs font-semibold " +
                  (rotate ? "bg-amber text-ink" : "text-muted")
                }
              >
                Switch each post
              </button>
            </div>
            </div>
          </div>
          {voicePicker(false)}
        </div>

        </div>
      </aside>
      </div>
      {google.dialogs}
      {confirmAction ? (
        <div className="nvr-dialog-root" role="presentation">
          <button type="button" className="nvr-dialog-backdrop" aria-label="Cancel" onClick={() => setConfirmAction(null)} />
          <div className="nvr-dialog" role="alertdialog" aria-modal="true" aria-labelledby="nvr-confirm-title">
            {confirmAction === "clear" ? (
              <>
                <h2 id="nvr-confirm-title" className="text-base font-semibold text-fg">Clear the queue?</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  This removes every card from the queue. Installed voice packs and your settings stay as they are. You can undo this.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirmAction(null)} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-fg">Cancel</button>
                  <button type="button" onClick={runClearQueue} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-danger bg-raise px-4 text-sm font-semibold text-danger">
                    <Trash2 className="size-4" />
                    Clear queue
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="nvr-confirm-title" className="text-base font-semibold text-fg">Reset settings to defaults?</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  This restores the voice, speed, volume, engine, and settings panel to their defaults. The queue and installed voice packs are not changed. You can undo this.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirmAction(null)} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-fg">Cancel</button>
                  <button type="button" onClick={runResetSettings} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-amber px-4 text-sm font-semibold text-ink">
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
