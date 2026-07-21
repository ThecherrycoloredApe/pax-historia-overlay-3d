// Assets binaires embarqués par esbuild (loader "binary").
declare module '*.glb' {
  const data: Uint8Array;
  export default data;
}
declare module '*.png' {
  const data: Uint8Array;
  export default data;
}
