import { createServerFn } from "@tanstack/react-start";
import { extractPageText } from "@/lib/page-text";

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 50_000;
const MAX_HOPS = 4;

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip.includes(":")) {
    if (ip === "::1" || ip === "::") return true;
    const head = ip.split(":")[0] ?? "";
    if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb")) {
      return true;
    }
    if (head.startsWith("fc") || head.startsWith("fd")) return true;
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    return false;
  }
  return isPrivateV4(ip);
}

function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a full link, including https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https links can be read.");
  }
  if (url.username || url.password) throw new Error("That link can't be read.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("That address can't be read.");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw new Error("That address can't be read.");
  }
  return url;
}

async function assertPublicHost(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw new Error("That address can't be read.");
    return;
  }
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
    throw new Error("That address can't be read.");
  }
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.length - offset);
    if (take <= 0) break;
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export const readPage = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { url?: unknown };
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!url) throw new Error("Enter a link first.");
    if (url.length > 2000) throw new Error("That link is too long.");
    return { url };
  })
  .handler(async ({ data }) => {
    let current: URL;
    try {
      current = parsePublicUrl(data.url);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "That link can't be read." };
    }

    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        await assertPublicHost(current);
        const res = await fetch(current, {
          redirect: "manual",
          signal: AbortSignal.timeout(12000),
          headers: {
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return { ok: false as const, error: "The page redirected nowhere." };
          current = parsePublicUrl(new URL(loc, current).href);
          continue;
        }
        if (!res.ok) return { ok: false as const, error: `The page returned ${res.status}.` };
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (type && !/text\/|xml|json|html/.test(type)) {
          return { ok: false as const, error: "That link isn't a text page." };
        }
        const body = await readBody(res);
        let text = body.trim();
        if (/html|xml/.test(type) || /<html|<body|<p[\s>]/i.test(body)) {
          const page = extractPageText(body);
          // Lead with the headline unless the article already opens with it.
          const opensWithTitle = page.title && page.text.slice(0, page.title.length + 20).includes(page.title);
          const heading = /[.!?:]$/.test(page.title) ? page.title : `${page.title}.`;
          text = page.title && !opensWithTitle ? `${heading}\n\n${page.text}` : page.text;
        }
        const collapsed = text.replace(/\s+/g, " ").trim();
        if (collapsed.length < 40) {
          return {
            ok: false as const,
            error: "That page didn't include readable text. It may only load in a browser. Paste it on a card instead.",
          };
        }
        const trimmed = collapsed.length > MAX_TEXT;
        return { ok: true as const, text: collapsed.slice(0, MAX_TEXT), trimmed };
      }
      return { ok: false as const, error: "That page redirected too many times." };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not read that page.";
      if (/abort|timeout/i.test(message)) return { ok: false as const, error: "The page took too long to respond." };
      if (message === "That address can't be read." || message.startsWith("Only http")) {
        return { ok: false as const, error: message };
      }
      return { ok: false as const, error: "Could not read that page." };
    }
  });
