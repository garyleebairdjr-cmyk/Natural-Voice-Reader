import { useEffect, useRef } from "react";

type Props = {
  /** Live analyser for generated audio. Null for the device voice, which has no stream to read. */
  analyser: AnalyserNode | null;
  /** True while speech is playing. */
  active: boolean;
  className?: string;
};

const BARS = 56;

function readColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Mirrored bar spectrum that follows the voice, and rests as a quiet line when idle. */
export function VoiceVisualizer({ analyser, active, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levels = useRef<Float32Array>(new Float32Array(BARS));
  const activeRef = useRef(active);
  const analyserRef = useRef(analyser);
  activeRef.current = active;
  analyserRef.current = analyser;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let width = 0;
    let height = 0;
    let colors = { a: "#ffb547", b: "#ff5f8f", track: "#6b7186" };
    let bins: Uint8Array<ArrayBuffer> = new Uint8Array(128);

    const refreshColors = () => {
      colors = {
        a: readColor("--color-amber", colors.a),
        b: readColor("--color-glow", colors.b),
        track: readColor("--color-track", colors.track),
      };
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time: number) => {
      const live = activeRef.current;
      const node = analyserRef.current;
      const target = levels.current;

      if (live && node) {
        if (bins.length !== node.frequencyBinCount) bins = new Uint8Array(node.frequencyBinCount);
        node.getByteFrequencyData(bins);
        // Speech lives in the lower bins; spread those across the bars, mirrored from the center.
        const usable = Math.floor(bins.length * 0.6);
        for (let i = 0; i < BARS; i++) {
          const fromCenter = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
          const bin = Math.min(usable - 1, Math.floor(fromCenter * usable));
          const v = (bins[bin] ?? 0) / 255;
          target[i] = target[i]! * 0.55 + v * 0.45;
        }
      } else if (live) {
        // Device voice: a soft synthetic wave so the stage still feels alive.
        const t = time / 1000;
        for (let i = 0; i < BARS; i++) {
          const x = i / BARS;
          const v =
            0.28 +
            0.22 * Math.sin(t * 5.2 + x * 9) * Math.sin(t * 1.7 + x * 3) +
            0.16 * Math.sin(t * 11 + x * 23);
          target[i] = target[i]! * 0.7 + Math.max(0.05, v) * 0.3;
        }
      } else {
        for (let i = 0; i < BARS; i++) target[i] = target[i]! * 0.86;
      }

      ctx.clearRect(0, 0, width, height);
      const gap = 3;
      const barW = Math.max(2, (width - gap * (BARS - 1)) / BARS);
      const mid = height / 2;
      const grad = ctx.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0, colors.a);
      grad.addColorStop(0.5, colors.b);
      grad.addColorStop(1, colors.a);

      let settled = true;
      for (let i = 0; i < BARS; i++) {
        const level = target[i]!;
        if (level > 0.01) settled = false;
        const h = Math.max(3, level * (height * 0.92));
        const x = i * (barW + gap);
        const r = Math.min(barW / 2, h / 2);
        ctx.fillStyle = level > 0.015 ? grad : colors.track;
        ctx.globalAlpha = level > 0.015 ? 0.55 + level * 0.45 : 0.35;
        ctx.beginPath();
        ctx.roundRect(x, mid - h / 2, barW, h, r);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (live || !settled) {
        raf = reduced && !live ? 0 : requestAnimationFrame(draw);
      } else {
        raf = 0;
      }
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    refreshColors();
    resize();
    kick();

    const ro = new ResizeObserver(() => {
      resize();
      kick();
    });
    ro.observe(canvas);
    // Theme or accent changes swap the CSS variables on <html>.
    const mo = new MutationObserver(() => {
      refreshColors();
      kick();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-ink"] });

    const poll = window.setInterval(() => {
      if (activeRef.current) kick();
    }, 250);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
