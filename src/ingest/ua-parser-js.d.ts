// Minimal types for ua-parser-js 1.x (MIT), which ships none. Only what src/ingest/ua.ts uses.
declare module "ua-parser-js" {
  interface UAResult {
    ua: string;
    browser: { name?: string; version?: string; major?: string };
    engine: { name?: string; version?: string };
    os: { name?: string; version?: string };
    device: { vendor?: string; model?: string; type?: string };
    cpu: { architecture?: string };
  }
  function UAParser(ua?: string): UAResult;
  export default UAParser;
}
