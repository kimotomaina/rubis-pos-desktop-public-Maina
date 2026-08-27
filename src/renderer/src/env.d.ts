/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOPIFY_STORE_URL: string
  readonly VITE_SHOPIFY_ADMIN_API_TOKEN: string
  /** When set, seeds the dummy demo catalog and shows the Demo Mode banner. */
  readonly VITE_DEMO_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export {}
