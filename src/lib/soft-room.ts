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
  master: GainNode;
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
  const master = ctx.createGain();
  dry.connect(master);
  wet.connect(master);
  master.connect(ctx.destination);
  const graph = { ctx, source, dry, wet, filter, convolver, master };
  graphs.set(audio, graph);
  return graph;
}

export function applyPlayback(
  audio: HTMLAudioElement,
  options: { softRoom: boolean; gain: number },
): void {
  if (typeof window === "undefined") return;
  const gain = Number.isFinite(options.gain) ? Math.min(1, Math.max(0, options.gain)) : 1;
  try {
    if (!options.softRoom && !graphs.has(audio)) {
      audio.muted = gain === 0;
      audio.volume = gain;
      return;
    }
    const graph = graphFor(audio);
    if (graph.ctx.state === "suspended") {
      void graph.ctx.resume();
    }
    // Subtle mix: mostly dry, a little room, no obvious wash.
    graph.dry.gain.value = options.softRoom ? 0.92 : 1;
    graph.wet.gain.value = options.softRoom ? 0.16 : 0;
    // Once a MediaElementSource exists, element volume is unreliable, so
    // the master gain is the live volume control for this path.
    audio.muted = false;
    audio.volume = 1;
    graph.master.gain.value = gain;
  } catch {
    audio.muted = gain === 0;
    audio.volume = gain;
  }
}

