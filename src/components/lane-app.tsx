import { useEffect, useRef, useState } from "react";
import {
  Download,
  Link2,
  Loader2,
  Moon,
  Pause,
  Play,
  Plus,
  Repeat,
  SkipBack,
  SkipForward,
  Sun,
  Trash2,
  Volume2,
} from "lucide-react";
import { getTtsStatus, prepareTtsEngine, synthesizeSpeech } from "@/lib/tts.functions";
import { readPage } from "@/lib/read-page.functions";
import { defaultInk, inksFor, inkFits, type ThemeName } from "@/lib/appearance";
import { SPEED_OPTIONS, useLane } from "@/lib/lane-store";
import { DEVICE_VOICE, voiceAccentLabel, voiceById, voiceForCard, VOICES, type Voice } from "@/lib/voices";
import { splitForStreaming } from "@/lib/sentences";
import { isLoadingVoiceError, modelLabel, TTS_MODELS, type TtsStatus } from "@/lib/tts-config";
import { resolveSpeechRoute } from "@/lib/voice-routing";
import { applySoftRoom } from "@/lib/soft-room";

type Phase = "idle" | "loading" | "playing" | "paused";

type CachedClip = { url: string; speedApplied: boolean };
type PreparedClip = { key: string; url: string; speedApplied: boolean; provider: "cache" | "voicestudio" | "kokoro" | "xai" };
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
  const repeat = useLane((s) => s.repeat);
  const ttsModel = useLane((s) => s.ttsModel);
  const setVoice = useLane((s) => s.setVoice);
  const setRotate = useLane((s) => s.setRotate);
  const setTtsModel = useLane((s) => s.setTtsModel);
  const softRoom = useLane((s) => s.softRoom);
  const setSoftRoom = useLane((s) => s.setSoftRoom);
  const setSpeed = useLane((s) => s.setSpeed);
  const setRepeat = useLane((s) => s.setRepeat);
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
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [pieceIndex, setPieceIndex] = useState(0);
  const [pieceCount, setPieceCount] = useState(1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const card = cards[index];
  const speaking = card ? voiceForCard(index, voiceId, rotate) : voiceById(voiceId);

  useEffect(() => {
    const finish = () => {
      useLane.setState({ voiceId: "leo" });
    };
    const unsub = useLane.persist.onFinishHydration(finish);
    void useLane.persist.rehydrate();
    return unsub;
  }, []);

  useEffect(() => {
    const activeInk = inkFits(theme, ink) ? ink : defaultInk(theme);
    if (activeInk !== ink) setInk(activeInk);
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.ink = activeInk;
  }, [theme, ink, setInk]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const d = audio.duration;
      setProgress(d && Number.isFinite(d) ? audio.currentTime / d : 0);
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
    const audio = audioRef.current;
    if (audio) applySoftRoom(audio, softRoom);
  }, [softRoom]);

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
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
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
  }, []);

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
      album: "Natural Web and Text Voice Reader",
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
    if (result.provider === "voicestudio" || result.provider === "xai" || result.provider === "kokoro") {
      const message = result.slow
        ? "Using local OmniVoice for German-accented English. This voice is slower, often around a minute for a short paragraph."
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
        const nextVoice = voiceForCard(cardIndex + 1, state.voiceId, state.rotate);
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
        if (token !== gen.current) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        resolve();
      };
      utterance.onerror = (event) => {
        clearKeep();
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
    const next = fromIndex + 1;
    if (next < state.cards.length) {
      void playAtRef.current(next);
      return;
    }
    if (state.repeat && state.cards.length > 0) {
      void playAtRef.current(0);
      return;
    }
    setPhase("idle");
    setProgress(1);
    playingId.current = null;
    void releaseScreen();
    const current = state.cards[fromIndex];
    if (current) {
      publishSession(current.text, voiceForCard(fromIndex, state.voiceId, state.rotate).name, false);
    }
  }
  advanceRef.current = advanceAfter;

  async function playGeneratedPieces(pieces: string[], voice: string, token: number, startAt: number) {
    const audio = audioRef.current;
    if (!audio) return;
    setPieceCount(pieces.length);
    for (let i = startAt; i < pieces.length; i++) {
      if (token !== gen.current || modeRef.current !== "lane") return;
      setPieceIndex(i);
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
      applySoftRoom(audio, useLane.getState().softRoom);
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
    const voice = voiceForCard(nextIndex, state.voiceId, state.rotate);
    setPhase("loading");
    setError(null);
    setNote(null);
    setAuditionId(null);
    setPieceIndex(0);
    setPieceCount(1);
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
      const first = await ensureAudio(pieces[0]!, voice.id, ac.signal);
      if (token !== gen.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      speedAppliedRef.current = first.speedApplied;
      audio.src = first.url;
      loadedKey.current = first.key;
      audio.playbackRate = first.speedApplied ? 1 : useLane.getState().speed;
      prefetchUpcoming(pieces, 0, nextIndex, voice.id);
      applySoftRoom(audio, useLane.getState().softRoom);
      await audio.play();
      if (token !== gen.current) {
        audio.pause();
        return;
      }
      markPlaying();
      setPieceCount(pieces.length);
      setPieceIndex(0);
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
    if (current) publishSession(current.text, voiceForCard(state.index, state.voiceId, state.rotate).name, false);
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
    const voice = current ? voiceForCard(state.index, state.voiceId, state.rotate) : null;
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
      applySoftRoom(audio, useLane.getState().softRoom);
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
    if (state.cards.length === 0) return;
    const upcoming = state.index + 1;
    if (upcoming >= state.cards.length) {
      if (state.repeat) void playAt(0);
      return;
    }
    void playAt(upcoming);
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
      applySoftRoom(audio, useLane.getState().softRoom);
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
    const voice = voiceForCard(cardIndex, state.voiceId, state.rotate);
    if (voice.id === "device") {
      setError("Device voices play in the browser and don't make a file. Choose Leo or another voice to download.");
      return;
    }
    setDownloadingId(item.id);
    setError(null);
    try {
      const pieces = splitForStreaming(item.text);
      const first = pieces[0] ?? item.text;
      const source = item.text.length <= 4096 ? item.text : first;
      const { url } = await ensureAudio(source, voice.id);
      if (source !== item.text) {
        setNote("This card is longer than the voice service allows in one file, so the download is the opening sentences. Play the card to hear the rest.");
      }
      saveFile(url, `natural-reader-${String(cardIndex + 1).padStart(2, "0")}-${voice.name.toLowerCase()}.mp3`);
    } catch (err) {
      if (!isAbort(err)) setError(err instanceof Error ? err.message : "Could not download that card.");
    } finally {
      setDownloadingId((current) => (current === item.id ? null : current));
    }
  }

  function chooseTheme(next: ThemeName) {
    setTheme(next);
    if (!inkFits(next, ink)) setInk(defaultInk(next));
  }

  const countLabel = cards.length === 0 ? "Empty queue" : `${index + 1} of ${cards.length}`;
  const inks = inksFor(theme);

  function transportBar(label: string) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3" aria-label={label}>
        <button
          type="button"
          aria-label="Previous"
          onClick={prev}
          disabled={cards.length === 0}
          className="inline-flex size-14 items-center justify-center rounded-full border border-line bg-surface text-fg disabled:opacity-40"
        >
          <SkipBack className="size-6" />
        </button>
        <button
          type="button"
          aria-label={phase === "playing" || phase === "loading" ? "Pause" : "Play"}
          onClick={toggle}
          disabled={cards.length === 0}
          className="inline-flex size-20 items-center justify-center rounded-full bg-amber text-ink disabled:opacity-40"
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
          className="inline-flex size-14 items-center justify-center rounded-full border border-line bg-surface text-fg disabled:opacity-40"
        >
          <SkipForward className="size-6" />
        </button>
        <button
          type="button"
          onClick={() => void downloadCard(index)}
          disabled={!card || downloadingId === card?.id}
          className="inline-flex min-h-12 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-fg disabled:opacity-40"
        >
          {downloadingId && downloadingId === card?.id ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Download
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto grid min-h-dvh max-w-6xl lg:grid-cols-5">
      <audio ref={audioRef} preload="none" className="hidden" />

      <section className="flex min-w-0 flex-col gap-5 px-4 pt-5 pb-safe sm:px-6 lg:col-span-3 lg:px-8 lg:pt-8 lg:pb-8">
        <header className="flex flex-col gap-3">
          <h1 className="font-display text-3xl leading-tight font-semibold text-balance text-fg sm:text-4xl">
            Natural Web and Text Voice Reader
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            Choose the Audio voice and read along, and/or download the audio file. (browsers may have limited
            voice options)
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Background">
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
            </div>
            <div className="flex items-center gap-2" role="group" aria-label="Text color">
              {inks.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`${item.label} text`}
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
          {error ? (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {note ? <p className="mt-3 text-sm text-muted">{note}</p> : null}
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
          <button
            type="button"
            onClick={() => setRepeat(!repeat)}
            aria-pressed={repeat}
            className={
              "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold " +
              (repeat ? "border-amber bg-raise text-amber" : "border-line bg-surface text-muted")
            }
          >
            <Repeat className="size-4" />
            Repeat
          </button>
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
          Generated voices come from local VoiceStudio on port 3900, from the Kokoro helper on port 3901 for Butler and the Indian and Japanese English voices, then from xAI if a key is set.
          German English voices use OmniVoice and are slower. Otherwise the browser device voice is used and every named voice will sound the same. The first sentence starts as soon as it is ready.
        </p>
      </section>

      <aside className="flex min-w-0 flex-col gap-6 border-line px-4 py-6 pb-safe sm:px-6 lg:col-span-2 lg:max-h-dvh lg:overflow-y-auto lg:border-l lg:px-5 lg:py-8">
        <div>
          <div className="mb-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Engine</h2>
              <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Local voice engine">
                {TTS_MODELS.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setTtsModel(model.id)}
                    aria-pressed={ttsModel === model.id}
                    title={model.note}
                    className={
                      "min-h-11 rounded-full px-3 text-xs font-semibold " +
                      (ttsModel === model.id ? "bg-amber text-ink" : "text-muted")
                    }
                  >
                    {model.label}
                  </button>
                ))}
              </div>
            </div>
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
          <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
            {[DEVICE_VOICE, ...VOICES].map((voice) => {
              const selected = voice.id === voiceId;
              return (
                <div
                  key={voice.id}
                  className={
                    "flex min-w-44 shrink-0 items-center gap-2 rounded-2xl border px-3 py-2 " +
                    (selected ? "border-amber bg-raise" : "border-line bg-surface")
                  }
                >
                  <button
                    type="button"
                    onClick={() => setVoice(voice.id)}
                    className="min-h-11 flex-1 text-left"
                  >
                    <span className="block text-sm font-semibold text-fg">{voice.name}</span>
                    <span className="block text-xs text-muted">{voice.note}</span>
                    {voiceAccentLabel(voice) ? (
                      <span className="block text-xs text-muted">{voiceAccentLabel(voice)}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Hear ${voice.name}`}
                    onClick={() => void audition(voice)}
                    className="inline-flex size-11 items-center justify-center rounded-full text-amber"
                  >
                    {auditionId === voice.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Volume2 className="size-4" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-fg uppercase">Queue</h2>
            <button
              type="button"
              onClick={() => {
                pause();
                clear();
                setProgress(0);
                loadedKey.current = null;
                playingId.current = null;
              }}
              disabled={cards.length === 0}
              className="text-xs font-semibold text-muted disabled:opacity-40"
            >
              Clear
            </button>
          </div>
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto lg:max-h-none lg:flex-1">
            {cards.map((item, i) => {
              const active = i === index;
              const v = voiceForCard(i, voiceId, rotate);
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
                      (active ? "border-amber bg-raise" : "border-line bg-surface")
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
                    className="inline-flex w-11 items-center justify-center rounded-2xl border border-line text-fg disabled:opacity-40"
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
            <button
              type="submit"
              disabled={reading}
              className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-amber px-4 text-sm font-semibold text-ink disabled:opacity-40"
            >
              {reading ? <Loader2 className="size-4 animate-spin" /> : source === "link" ? <Link2 className="size-4" /> : <Plus className="size-4" />}
              {reading ? "Reading page" : source === "link" ? "Read page" : "Add to lane"}
            </button>
            <button
              type="button"
              disabled={reading}
              onClick={() => (source === "link" ? void commitPage("replace") : commitPaste("replace"))}
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-line px-4 text-sm font-semibold text-fg disabled:opacity-40"
            >
              Replace
            </button>
          </div>
          {composerNote ? <p className="text-xs text-muted">{composerNote}</p> : null}
        </form>
      </aside>
    </div>
  );
}
