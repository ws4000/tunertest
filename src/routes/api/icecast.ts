import { createFileRoute } from "@tanstack/react-router";

const ICECAST_BASE = "https://radio.soupco.net:8443";

export const Route = createFileRoute("/api/icecast")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const res = await fetch(`${ICECAST_BASE}/status-json.xsl`, {
            headers: { Accept: "application/json" },
          });
          const text = await res.text();
          return new Response(text, {
            status: res.status,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
            },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      },
    },
  },
});