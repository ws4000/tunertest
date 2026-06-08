import { createFileRoute } from "@tanstack/react-router";
import adminHtml from "../admin.html?raw";

export const Route = createFileRoute("/admin")({
  server: {
    handlers: {
      GET: async () =>
        new Response(adminHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  },
});