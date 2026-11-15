// Injected at build time by vite.config.ts `define`; see APP_COMMIT in the Dockerfile/CI workflow.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

export const APP_VERSION: string = __APP_VERSION__;
export const APP_COMMIT: string = __APP_COMMIT__;
