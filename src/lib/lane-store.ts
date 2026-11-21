import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cardsFromPage, cardsFromPaste, type Card } from "@/lib/chunk-text";
import { defaultInk, type ThemeName } from "@/lib/appearance";
import { SAMPLE_LANE } from "@/lib/samples";
import { DEFAULT_VOICESTUDIO_MODEL, isTtsModelId, type TtsModelId } from "@/lib/tts-config";
import { canonicalVoiceId } from "@/lib/voices";
import {
  clampVolume,
  DEFAULT_VOLUME,
  migrateLaneState,
} from "@/lib/lane-persist";

export { clampVolume, DEFAULT_VOLUME, effectiveGain, migrateLaneState } from "@/lib/lane-persist";

export const SPEED_OPTIONS = [
  { value: 0.9, label: "Slow" },
  { value: 1, label: "Road" },
  { value: 1.15, label: "Brisk" },
  { value: 1.35, label: "Fast" },
] as const;
export type Speed = (typeof SPEED_OPTIONS)[number]["value"];

type LaneState = {
  cards: Card[];
  index: number;
  voiceId: string;
  rotate: boolean;
  ttsModel: TtsModelId;
  softRoom: boolean;
  volume: number;
  muted: boolean;
  speed: Speed;
  repeat: boolean;
  theme: ThemeName;
  ink: string;
  seeded: boolean;
  setVoice: (id: string) => void;
  setRotate: (rotate: boolean) => void;
  setTtsModel: (model: TtsModelId) => void;
  setSoftRoom: (softRoom: boolean) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setSpeed: (speed: Speed) => void;
  setRepeat: (repeat: boolean) => void;
  setTheme: (theme: ThemeName) => void;
  setInk: (ink: string) => void;
  setIndex: (index: number) => void;
  addPaste: (raw: string, mode: "append" | "replace") => number;
  addPage: (raw: string, mode: "append" | "replace") => number;
  loadSamples: (mode: "append" | "replace") => void;
  removeCard: (id: string) => void;
  clear: () => void;
};

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

export const useLane = create<LaneState>()(
  persist(
    (set, get) => {
      const place = (next: Card[], mode: "append" | "replace") => {
        if (next.length === 0) return 0;
        if (mode === "replace") {
          set({ cards: next, index: 0, seeded: true });
        } else {
          const cards = [...get().cards, ...next];
          const index = get().cards.length === 0 ? 0 : get().index;
          set({ cards, index, seeded: true });
        }
        return next.length;
      };
      return {
      cards: cardsFromPaste(SAMPLE_LANE),
      index: 0,
      voiceId: "leo",
      rotate: false,
      ttsModel: DEFAULT_VOICESTUDIO_MODEL,
      softRoom: false,
      volume: DEFAULT_VOLUME,
      muted: false,
      speed: 1,
      repeat: false,
      theme: "dark",
      ink: defaultInk("dark"),
      seeded: true,
      setVoice: (voiceId) => set({ voiceId: canonicalVoiceId(voiceId) }),
      setRotate: (rotate) => set({ rotate }),
      setTtsModel: (ttsModel) => set({ ttsModel: isTtsModelId(ttsModel) ? ttsModel : DEFAULT_VOICESTUDIO_MODEL }),
      setSoftRoom: (softRoom) => set({ softRoom }),
      setVolume: (volume) => set({ volume: clampVolume(volume), muted: false }),
      setMuted: (muted) => set({ muted: Boolean(muted) }),
      setSpeed: (speed) => set({ speed }),
      setRepeat: (repeat) => set({ repeat }),
      setTheme: (theme) => set({ theme }),
      setInk: (ink) => set({ ink }),
      setIndex: (index) => set({ index: clampIndex(index, get().cards.length) }),
      addPaste: (raw, mode) => place(cardsFromPaste(raw), mode),
      addPage: (raw, mode) => place(cardsFromPage(raw), mode),
      loadSamples: (mode) => {
        get().addPaste(SAMPLE_LANE, mode);
      },
      removeCard: (id) => {
        const { cards, index } = get();
        const at = cards.findIndex((c) => c.id === id);
        if (at < 0) return;
        const next = cards.filter((c) => c.id !== id);
        let nextIndex = index;
        if (next.length === 0) nextIndex = 0;
        else if (at < index) nextIndex = index - 1;
        else if (at === index) nextIndex = Math.min(index, next.length - 1);
        set({ cards: next, index: nextIndex });
      },
      clear: () => set({ cards: [], index: 0, seeded: true }),
      };
    },
    {
      name: "lane-reader",
      skipHydration: true,
      version: 5,
      migrate: migrateLaneState,
      partialize: (s) => ({
        cards: s.cards,
        index: s.index,
        voiceId: canonicalVoiceId(s.voiceId),
        rotate: s.rotate,
        ttsModel: isTtsModelId(s.ttsModel) ? s.ttsModel : DEFAULT_VOICESTUDIO_MODEL,
        softRoom: Boolean(s.softRoom),
        volume: clampVolume(s.volume),
        muted: Boolean(s.muted),
        speed: s.speed,
        repeat: s.repeat,
        theme: s.theme,
        ink: s.ink,
        seeded: s.seeded,
      }),
    },
  ),
);
