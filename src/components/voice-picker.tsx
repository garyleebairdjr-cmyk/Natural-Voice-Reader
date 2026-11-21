import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Loader2, Star, Volume2 } from "lucide-react";
import { packIdForVoice, type VoicePackStatus } from "@/lib/voice-packs";
import { groupVoices, voiceBadges, voiceSearchText } from "@/lib/voice-picker";
import { voiceById, type Voice } from "@/lib/voices";

type Props = {
  voices: Voice[];
  value: string;
  onChange: (id: string) => void;
  onPreview: (voice: Voice) => void;
  auditionId: string | null;
  favoriteIds: string[];
  recentIds: string[];
  onToggleFavorite: (id: string) => void;
  ttsModel: string;
  packs?: VoicePackStatus[] | null;
  compact?: boolean;
  id?: string;
};

export function VoicePicker({
  voices,
  value,
  onChange,
  onPreview,
  auditionId,
  favoriteIds,
  recentIds,
  onToggleFavorite,
  ttsModel,
  packs,
  compact = false,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const selected = voices.find((voice) => voice.id === value) ?? (value === "device" ? voiceById("device") : voiceById(value));
  const engines = useMemo(() => {
    const map: Record<string, string> = {};
    if (!packs) return map;
    for (const voice of voices) {
      const packId = packIdForVoice(voice.id, packs);
      const pack = packs.find((item) => item.id === packId);
      if (pack) map[voice.id] = pack.engine;
    }
    return map;
  }, [packs, voices]);

  const groups = useMemo(
    () =>
      groupVoices(voices, {
        favoriteIds,
        recentIds,
        selectedModel: ttsModel,
        engines,
      }),
    [voices, favoriteIds, recentIds, ttsModel, engines],
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          id={id}
          aria-label={compact ? `Voice: ${selected.name}. Open the voice picker.` : "Open the voice picker"}
          className={
            compact
              ? "inline-flex min-h-12 max-w-48 items-center gap-2 rounded-full border border-line bg-surface px-3 text-left text-sm font-semibold text-fg"
              : "flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-3 text-left text-sm font-semibold text-fg"
          }
        >
          <span className="min-w-0 truncate">{selected.name}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={compact ? "center" : "start"}
          side="bottom"
          sideOffset={8}
          className="nvr-voice-popover z-50 w-[min(24rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-surface p-2 shadow-xl"
        >
          <Command label="Voice picker" className="flex flex-col gap-2">
            <Command.Input
              autoFocus
              placeholder="Search voices"
              className="min-h-11 w-full rounded-xl border border-line bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-amber"
            />
            <Command.List className="max-h-80 overflow-y-auto">
              <Command.Empty className="px-3 py-6 text-sm text-muted">No voices match that search.</Command.Empty>
              {groups.map((group) => (
                <Command.Group key={group.id} heading={group.label} className="nvr-voice-group">
                  {group.voices.map((voice) => {
                    const badges = voiceBadges(voice, ttsModel, engines[voice.id]);
                    const favorite = favoriteIds.includes(voice.id);
                    const active = voice.id === value;
                    return (
                      <Command.Item
                        key={`${group.id}-${voice.id}`}
                        value={`${group.id} ${voiceSearchText(voice, ttsModel, engines[voice.id])}`}
                        onSelect={() => {
                          onChange(voice.id);
                          setOpen(false);
                        }}
                        className={
                          "flex cursor-pointer items-start gap-2 rounded-xl px-2 py-2 text-sm data-[selected=true]:bg-raise " +
                          (active ? "bg-raise" : "")
                        }
                      >
                        <span className="mt-1 size-4 shrink-0 text-amber">{active ? <Check className="size-4" /> : null}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-fg">{voice.name}</span>
                          {voice.note ? <span className="mt-0.5 block text-xs text-muted">{voice.note}</span> : null}
                          <span className="mt-1 flex flex-wrap gap-1">
                            {badges.map((badge) => (
                              <span
                                key={badge.kind}
                                className="rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
                              >
                                {badge.label}
                              </span>
                            ))}
                          </span>
                        </span>
                        <button
                          type="button"
                          aria-label={favorite ? `Remove ${voice.name} from favorites` : `Add ${voice.name} to favorites`}
                          aria-pressed={favorite}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleFavorite(voice.id);
                          }}
                          className={"inline-flex size-11 shrink-0 items-center justify-center rounded-full " + (favorite ? "text-amber" : "text-muted")}
                        >
                          <Star className={"size-4 " + (favorite ? "fill-current" : "")} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Preview ${voice.name}`}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onPreview(voice);
                          }}
                          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-amber"
                        >
                          {auditionId === voice.id ? <Loader2 className="size-4 animate-spin" /> : <Volume2 className="size-4" />}
                        </button>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
