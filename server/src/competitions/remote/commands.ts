/**
 * The three commands a machine joins with (§8.1), as the «Подключить машину»
 * dialog shows them with the code inside (MintRemoteCodeResponse.commands).
 *
 * BYTE FOR BYTE WHAT `colloq-host runner-code` PRINTS (deploy/vast/colloq-host
 * · runner_code), minus the two spaces it indents a command by on a
 * terminal: the owner who mints a code on the instance's console and the one
 * who mints it in the panel copy the same command, and a machine joined
 * either way is the same machine. tests/remote-runner-commands.test.mts runs
 * colloq-host itself with a stand-in docker and holds the two equal, image
 * naming rule included, so a change to one that the other did not get fails
 * there rather than on a rented VM.
 *
 * THE IMAGE is this release's, under the name that says what it is off Vast:
 * colloq-vast and colloq-server are one digest under two names, and a
 * machine runs `colloq-server:<version>`, the release the instance was
 * built as rather than a moving tag. An instance on an image of its own (a
 * university's registry) names that image whole, and `make vast-runner` is
 * left out — its machines take the published colloq-server of this release,
 * which would not be this instance's build.
 */
import { homeOrigin } from './origin.js'

/** The agent's container, the same name colloq-host gives it (RUNNER_NAME). */
export const RUNNER_CONTAINER = 'colloq-runner'

const OFFICIAL = /^ghcr\.io\/colloq-edu\/colloq-(vast|server)(:[^/@]+|@sha256:[a-f0-9]{64})$/
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/
const PUBLISHED = /^ghcr\.io\/colloq-edu\/colloq-server:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/
const SERVER = 'ghcr.io/colloq-edu/colloq-server'

/**
 * The image machines are told to run, by colloq-host's rule: the instance's
 * own image `image` (null — not known here, which is the published one of
 * `version`); an official image by the release it was built as
 * (`version`, the image's org.opencontainers.image.version), or, without
 * one, by its own tag or digest under the colloq-server name; any other
 * image as it is. `published` — the very image `runner up` and `make
 * vast-runner` take by themselves.
 */
export function runnerImage(image: string | null | undefined, version: string): { image: string; published: boolean } {
  let shown: string
  if (!image) shown = `${SERVER}:${version}`
  else if (OFFICIAL.test(image)) {
    if (RELEASE.test(version)) shown = `${SERVER}:${version}`
    else {
      const suffix = image.startsWith('ghcr.io/colloq-edu/colloq-vast') ? image.slice('ghcr.io/colloq-edu/colloq-vast'.length) : image.slice('ghcr.io/colloq-edu/colloq-server'.length)
      shown = `${SERVER}${suffix}`
    }
  } else shown = image
  return { image: shown, published: PUBLISHED.test(shown) }
}

/**
 * The commands, with the code inside each: `docker` for a machine with
 * Docker already installed, `bare` for one without (it installs Docker and
 * colloq-host, which adds the NVIDIA toolkit and checks the driver), and
 * `vast` for rented Vast VMs from a checkout — '' when the instance runs an
 * image of its own, which those VMs would not take.
 */
export function runnerJoinCommands(input: { home: string; code: string; image: string; published: boolean; machines: number }): { docker: string; bare: string; vast: string } {
  const url = homeOrigin(input.home) ?? input.home.replace(/\/+$/, '')
  const { code, image } = input
  const docker = [
    `docker run -d --name ${RUNNER_CONTAINER} --restart unless-stopped \\`,
    '  -v /var/run/docker.sock:/var/run/docker.sock \\',
    '  -v /var/lib/colloq-runner:/var/lib/colloq-runner \\',
    `  -e COLLOQ_RUNNER_JOIN='${url}#${code}' \\`,
    `  ${image} runner`,
  ].join('\n')
  const bare = [
    'command -v docker || curl -fsSL https://get.docker.com | sh',
    `docker run --rm -v /usr/local/sbin:/host ${image} install-host /host`,
    input.published ? `colloq-host runner up ${url} ${code}` : `colloq-host runner up ${url} ${code} ${image}`,
  ].join('\n')
  const vast = input.published ? `make vast-runner COUNT=${input.machines} CODE=${code} URL=${url}` : ''
  return { docker, bare, vast }
}

/**
 * The image this instance runs, when its deployment says so
 * (COLLOQ_SERVER_IMAGE); `null` — it does not, and the published image of
 * this release is the answer. The server cannot ask the daemon about its own
 * container without knowing which one it is, and guessing from the hostname
 * would name a stranger's image on a host with several.
 */
export function ownImage(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.COLLOQ_SERVER_IMAGE?.trim()
  return named ? named : null
}
