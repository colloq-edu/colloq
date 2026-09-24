/**
 * The version the server reports about itself: `/api/health` and the startup
 * log.
 *
 * The number comes from the ROOT package.json, the same one the wheel, the web
 * app (vite define) and the release tags take it from: the version has no
 * other source, and the copies in the workspaces' package.json files are only
 * checked against it (scripts/version.mts check).
 *
 * A JSON import, not a file read at startup. esbuild inlines the object into
 * the bundle at build time, so the built server.js knows its version wherever
 * it lies: in the image there is no root package.json next to it (the
 * Dockerfile puts the server's own there), and in the wheel there is another
 * one, from pack.mts. Under tsx (make dev, tests) the same import reads the
 * file from the tree.
 */
import rootPackage from '../../package.json' with { type: 'json' }

export const COLLOQ_VERSION: string = rootPackage.version
