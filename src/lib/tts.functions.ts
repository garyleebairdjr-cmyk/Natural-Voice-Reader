import { createServerFn } from "@tanstack/react-start";
import { isVoiceId } from "@/lib/voices";

const MAX_CHARS = 5000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return btoa(binary);
}

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { text?: unknown; voiceId?: unknown };
    const text = typeof raw.text === "string" ? raw.text.replace(/\s+/g, " ").trim() : "";
    const voiceId = typeof raw.voiceId === "string" && isVoiceId(raw.voiceId) ? raw.voiceId : "leo";
    if (!text) throw new Error("Nothing to read.");
    if (text.length > MAX_CHARS) throw new Error("A card can be at most 5,000 characters.");
    return { text, voiceId };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, error: "Voice is not available in this environment." };

    let res: Response;
    try {
      res = await fetch("https://api.x.ai/v1/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          text: data.text,
          voice_id: data.voiceId,
          language: "en",
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      return { ok: false as const, error: "Could not reach the voice service." };
    }

    if (!res.ok) return { ok: false as const, error: `Voice service error (${res.status}).` };

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 64) return { ok: false as const, error: "The voice came back empty." };

    return { ok: true as const, audio: bytesToBase64(bytes), mime: "audio/mpeg" };
  });
