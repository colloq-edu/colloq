/**
 * The project version — the string from the root package.json. Vite
 * substitutes it (`define` in vite.config.ts) both in the build and in the dev
 * server: the web has no copy of the number of its own, otherwise the panel
 * would show one version and /api/health another.
 *
 * A global constant, not an import of package.json: the import would drag the
 * whole root manifest with its scripts into the bundle for the sake of one
 * string.
 */
declare const __COLLOQ_VERSION__: string
