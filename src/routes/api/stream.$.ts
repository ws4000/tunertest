import { createFileRoute } from "@tanstack/react-router";

const ICECAST_BASE = "https://radio.soupco.net:8443";

export const Route = createFileRoute("/api/stream/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const mount = params._splat ?? "";
        const upstream = `${ICECAST_BASE}/${mount}`;
        const range = request.headers.get("range");
        const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (FakeTuner)" };
        if (range) headers["Range"] = range;
        const res = await fetch(upstream, { headers });
        const outHeaders = new Headers();
        const passThrough = ["content-type", "content-length", "accept-ranges", "content-range", "icy-name", "icy-genre", "icy-br"];
        for (const h of passThrough) {
          const v = res.headers.get(h);
          if (v) outHeaders.set(h, v);
        }
        if (!outHeaders.has("content-type")) outHeaders.set("content-type", "audio/mpeg");
        outHeaders.set("Access-Control-Allow-Origin", "*");
        outHeaders.set("Cache-Control", "no-store");
        return new Response(res.body, { status: res.status, headers: outHeaders });
      },
    },
  },
});