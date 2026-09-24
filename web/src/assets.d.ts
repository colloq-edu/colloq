/**
 * Imports with `?url`, which Vite turns into the address of the emitted file.
 *
 * TypeScript does not know about them: the suffix is the bundler's
 * convention, not the module system's. These declarations usually come from
 * `vite/client`, but that drags in the whole rest of the Vite environment,
 * while exactly one case is needed — the pdf.js worker, which has to live in
 * a separate file and be loaded by address.
 */
declare module '*?url' {
  const url: string
  export default url
}
