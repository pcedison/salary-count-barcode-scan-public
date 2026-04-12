/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_LIFF_ID?: string;
  // add other VITE_ vars here
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
