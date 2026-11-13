declare const __AW_BUILD__: { phase: string; sha: string; built: string };
export const BUILD = typeof __AW_BUILD__ === "undefined" ? { phase: "dev", sha: "local", built: "" } : __AW_BUILD__;
