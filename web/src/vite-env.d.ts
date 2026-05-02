/// <reference types="vite/client" />

declare global {
  interface Window {
    __APP_BASE_PATH__?: string;
  }
}

export {};
