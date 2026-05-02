import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
// `base: "./"` makes asset URLs relative to index.html so that the SPA works
// regardless of the runtime base path (`APP_BASE_PATH`). Only the JS literal
// `"__APP_BASE_PATH__"` in index.html is substituted server-side at request
// time; CSS/JS assets are looked up by relative URL from the current page.
export default defineConfig({
    base: "./",
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 5173,
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: false,
        target: "es2020",
    },
});
