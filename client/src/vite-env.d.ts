/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIFF_ID?: string;
  // add other VITE_ vars here
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
