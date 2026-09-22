import { createFileRoute } from "@tanstack/react-router";

const ICECAST_BASE = "https://radio.soupco.net:8443";

export const Route = createFileRoute("/api/stream/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const mount = params._splat ?? "";
        // Allow arbitrary upstream stream URLs by URL-encoding the full URL
        // as the mount path. Anything not starting with http(s):// is treated
        // as a mount on the default Icecast server for back-compat.
        let decoded = mount;
        try { decoded = decodeURIComponent(mount); } catch (e) {}
        const upstream = /^https?:\/\//i.test(decoded)
          ? decoded
          : `${ICECAST_BASE}/${mount}`;
        const range = request.headers.get("range");
        const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (FakeTuner)" };
        if (range) headers["Range"] = range;

        // A missing/broken upstream stream is a normal condition for a tuner
        // (station offline). Reply 204 No Content so the audio element simply
        // gets no data instead of surfacing an app-level 5xx error page.
        const silent = () =>
          new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
            },
          });

        try {
          const res = await fetch(upstream, {
            headers,
            cache: "no-store",
            redirect: "follow",
          });
          if (!res.ok || !res.body) {
            console.warn("stream proxy upstream error", upstream, res.status);
            return silent();
          }

          const outHeaders = new Headers();
          // NOTE: never forward hop-by-hop headers (transfer-encoding, connection)
          const passThrough = [
            "content-type",
            "accept-ranges",
            "content-range",
            "icy-name",
            "icy-genre",
            "icy-br",
            "icy-metaint",
          ];
          for (const h of passThrough) {
            const v = res.headers.get(h);
            if (v) outHeaders.set(h, v);
          }
          if (!outHeaders.has("content-type")) outHeaders.set("content-type", "audio/mpeg");
          outHeaders.set("Access-Control-Allow-Origin", "*");
          outHeaders.set("Cache-Control", "no-store");
          return new Response(res.body, { status: res.status === 206 ? 206 : 200, headers: outHeaders });
        } catch (err) {
          console.error("stream proxy failed", upstream, err);
          return fail("Upstream stream unavailable");
        }
      },
    },
  },
});