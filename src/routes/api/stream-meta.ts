import { createFileRoute } from "@tanstack/react-router";

// Read the ICY StreamTitle from an arbitrary Shoutcast/Icecast stream URL
// by requesting inline metadata (`Icy-MetaData: 1`), skipping one audio
// block, and parsing the metadata payload. Returns `{ title }` — an empty
// string when the upstream does not expose metadata.
export const Route = createFileRoute("/api/stream-meta")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url).searchParams.get("url");
        const json = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), {
            status,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
            },
          });
        if (!url || !/^https?:\/\//i.test(url)) return json({ error: "url required" }, 400);
        try {
          const upstream = await fetch(url, {
            headers: {
              "Icy-MetaData": "1",
              "User-Agent": "Mozilla/5.0 (FakeTuner)",
            },
            cache: "no-store",
          });
          const metaint = parseInt(upstream.headers.get("icy-metaint") || "0", 10);
          if (!metaint || !upstream.body) {
            try { upstream.body?.cancel(); } catch (e) {}
            return json({ title: "" });
          }
          const reader = upstream.body.getReader();
          let skipped = 0;
          let metaLen = -1;
          const metaBytes: number[] = [];
          // Hard cap so we never read forever on a broken stream.
          const maxRead = metaint + 1 + 4096;
          let read = 0;
          try {
            while (read < maxRead) {
              const { value, done } = await reader.read();
              if (done || !value) break;
              for (let i = 0; i < value.length && read < maxRead; i++) {
                read++;
                if (skipped < metaint) { skipped++; continue; }
                if (metaLen === -1) {
                  metaLen = value[i] * 16;
                  if (metaLen === 0) {
                    try { reader.cancel(); } catch (e) {}
                    return json({ title: "" });
                  }
                  continue;
                }
                metaBytes.push(value[i]);
                if (metaBytes.length >= metaLen) {
                  try { reader.cancel(); } catch (e) {}
                  const raw = new TextDecoder("utf-8", { fatal: false })
                    .decode(new Uint8Array(metaBytes));
                  // Match up to the canonical `';` terminator so that
                  // titles containing apostrophes (e.g. "It's My Life")
                  // are captured in full. Fall back to non-greedy match
                  // ending at the last `'` before `;` or end of string.
                  let m = /StreamTitle='([\s\S]*?)';/.exec(raw);
                  if (!m) m = /StreamTitle='([\s\S]*)'\s*(?:;|$)/.exec(raw);
                  const title = (m ? m[1] : "").replace(/\0+$/, "").trim();
                  return json({ title });
                }
              }
            }
          } finally {
            try { reader.cancel(); } catch (e) {}
          }
          return json({ title: "" });
        } catch (e) {
          return json({ title: "", error: String(e) });
        }
      },
    },
  },
});
