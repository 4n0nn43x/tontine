import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API, the event stream and the RPC proxy come from the Node server (ts/src/server.ts).
const api = process.env.TONTINE_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": api, "/rpc": api } },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
