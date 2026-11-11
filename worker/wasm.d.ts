declare module '*.wasm' { const mod: WebAssembly.Module; export default mod; }
declare module '@jsquash/webp/codec/enc/webp_enc.js' { const factory: (options:any)=>Promise<any>; export default factory; }
