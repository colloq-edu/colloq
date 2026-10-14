// The build of the machines that run submissions: dist/runner.sha256, the
// sha256 of dist/runner.js, written right after esbuild writes the bundle
// (server/package.json · build).
//
// It is the build home compares with a machine's before handing it new work
// (shared/remote-runner.ts · REMOTE_BUILD_FILE, remoteCompatible; the owner's
// decision 5): two machines with one build run a notebook identically, and a
// machine with another one is «устарел». Written as `sha256sum` prints it,
// the digest and then the file's name, so that `sha256sum -c runner.sha256`
// in dist/ checks it as it is; parseRemoteBuildFile and the image's guard
// (deploy/vast/Dockerfile) read the first field.
//
// Plain JavaScript beside src/, not TypeScript inside it: the build runs it
// with bare node, in the image's build stage as well, where server/ is all
// there is (the root's scripts/ is not copied there). The directory is an
// argument for tests; by default it is the dist/ next to this folder.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = 'runner.js'
const BUILD_FILE = 'runner.sha256'

const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'))
const digest = createHash('sha256').update(fs.readFileSync(path.join(dist, BUNDLE))).digest('hex')
fs.writeFileSync(path.join(dist, BUILD_FILE), `${digest}  ${BUNDLE}\n`)
