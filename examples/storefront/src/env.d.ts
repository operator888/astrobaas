interface ImportMetaEnv {
  readonly PUBLIC_CMS_URL: string;
  readonly PUBLIC_SHOP_NAME?: string;
  readonly PUBLIC_SHOP_TAGLINE?: string;
  readonly PUBLIC_SHIP_COUNTRIES?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
