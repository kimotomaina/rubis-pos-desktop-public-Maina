/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOPIFY_STORE_URL: string
  readonly VITE_SHOPIFY_ADMIN_API_TOKEN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export {}
