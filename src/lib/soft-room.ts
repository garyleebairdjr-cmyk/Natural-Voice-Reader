/**
 * A light, dry "soft room" playback effect. It is applied only in the
 * browser after the clip is generated, and does not change downloaded files.
 */

type Graph = {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  dry: GainNode;
  wet: GainNode;
  filter: BiquadFilterNode;
  convolver: ConvolverNode;
};

const graphs = new WeakMap<HTMLAudioElement, Graph>();

function impulse(ctx: AudioContext): AudioBuffer {
  const seconds = 0.28;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const decay = Math.exp(-i / (ctx.sampleRate * 0.07));
      data[i] = (Math.random() * 2 - 1) * decay * 0.32;
    }
  }
  return buffer;
}

function graphFor(audio: HTMLAudioElement): Graph {
  const existing = graphs.get(audio);
  if (existing) return existing;
  const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    throw new Error("This browser has no Web Audio support.");
  }
  const ctx = new Ctx();
  const source = ctx.createMediaElementSource(audio);
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const convolver = ctx.createConvolver();
  filter.type = "highshelf";
  filter.frequency.value = 8000;
  filter.gain.value = -2;
  convolver.buffer = impulse(ctx);
  source.connect(dry);
  source.connect(filter);
  filter.connect(convolver);
  convolver.connect(wet);
  dry.connect(ctx.destination);
  wet.connect(ctx.destination);
  const graph = { ctx, source, dry, wet, filter, convolver };
  graphs.set(audio, graph);
  return graph;
}

export function applySoftRoom(audio: HTMLAudioElement, enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (!enabled && !graphs.has(audio)) return;
    const graph = graphFor(audio);
    if (graph.ctx.state === "suspended") {
      void graph.ctx.resume();
    }
    // Subtle mix: mostly dry, a little room, no obvious wash.
    graph.dry.gain.value = enabled ? 0.92 : 1;
    graph.wet.gain.value = enabled ? 0.16 : 0;
  } catch {
    // If Web Audio is blocked, playback still works through the element.
  }
}
