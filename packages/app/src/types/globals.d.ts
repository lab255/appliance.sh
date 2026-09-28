// Baked in at lib build time by Vite `define` (see vite.config.ts).
declare const __APPLIANCE_VERSION__: string;
declare const __APPLIANCE_BUILD_TIME__: string;

declare module '*.svg' {
  const url: string;
  export default url;
}
