import { createFileRoute } from "@tanstack/react-router";
import tunerHtml from "../tuner.html?raw";

export const Route = createFileRoute("/$receiver")({
  server: {
    handlers: {
      GET: async () =>
        new Response(tunerHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  },
});