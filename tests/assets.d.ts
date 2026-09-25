/**
 * Image imports for renderer components mounted in tests.
 *
 * The renderer's own typecheck gets these from `vite/client`; the node
 * typecheck that also covers `tests/` does not, so a test that mounts a
 * screen showing the logo needs this declaration. Vite resolves the import
 * to the asset's URL string, which is all the components use.
 */
declare module '*.png' {
  const src: string
  export default src
}
