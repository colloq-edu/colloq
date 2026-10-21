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
 * An image only this host holds, whatever it is called: its id — `sha256:`
 * and the hex, or the hex alone, whole or short (twelve digits and up, as
 * `docker images` prints one) — or the local tag colloq-host keeps an image
 * with neither a name nor a digest by across an update
 * (`colloq-previous:<stamp>`, colloq-host · rollback_ref).
 * `colloq-host update sha256:…` runs the instance by its id, and the
 * rollback that update prints (`colloq-host restore --image …`) by that tag,
 * or by the id where the tag could not be made; COLLOQ_SERVER_IMAGE then
 * says just that, and a machine runs it only if it already holds that very
 * image: it pulls none. The entry point drops a bare id from the daemon the
 * same way (deploy/vast/entrypoint.sh · locate_server_image).
 */
const LOCAL_ONLY = /^((sha256:)?[a-f0-9]{12,64}|colloq-previous:[^/@]+)$/

/**
 * The image machines are told to run, by colloq-host's rule: the instance's
 * own image `image` (null — not known here, which is the published one of
 * `version`, and so is an image only this host holds, LOCAL_ONLY: the same
 * commands as with no image named); an official image by the release it
 * was built as (`version`, the image's org.opencontainers.image.version),
 * or, without one, by its own tag or digest under the colloq-server name;
 * any other image as it is. `published` — the very image `runner up` and
 * `make vast-runner` take by themselves.
 */
export function runnerImage(image: string | null | undefined, version: string): { image: string; published: boolean } {
  let shown: string
  if (!image || LOCAL_ONLY.test(image)) shown = `${SERVER}:${version}`
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
 *
 * `--stop-timeout 90`, as colloq-host's own `docker run` of the agent gives
 * it: on SIGTERM the agent hands back the runs it holds (a `draining`
 * decline each, through a relay's backoff of up to 30 s a try), and an image
 * cannot set its own stop timeout. With Docker's 10 s a `docker stop`, a
 * restart or a reboot of a machine joined this way killed the agent first,
 * and its runs came back as losses after the container started.
 *
 * `--network host` for every machine (remote-classes.md D19), as colloq-host
 * gives it: a class kernel's Jupyter is published on the host's 127.0.0.1
 * only, where the agent reaches it and the machine's public address never
 * does. A machine joined without it takes submissions and no classes, and
 * the panel says to join it again with these.
 *
 * `classes` — a code for machines that take classes («Принимать занятия»):
 * colloq-host's `runner up` is told so (`--classes`) and checks first that
 * this machine can host them (its Docker, its cgroups, no Colloq server
 * beside it, its disk), before anything is pulled or started. The flag is
 * the code's, not the command's: a machine joined by the other two commands
 * takes classes all the same, and the panel names what it lacks.
 */
export function runnerJoinCommands(input: { home: string; code: string; image: string; published: boolean; machines: number; classes?: boolean }): { docker: string; bare: string; vast: string } {
  const url = homeOrigin(input.home) ?? input.home.replace(/\/+$/, '')
  const { code, image } = input
  const docker = [
    `docker run -d --name ${RUNNER_CONTAINER} --restart unless-stopped --network host --stop-timeout 90 \\`,
    '  -v /var/run/docker.sock:/var/run/docker.sock \\',
    '  -v /var/lib/colloq-runner:/var/lib/colloq-runner \\',
    `  -e COLLOQ_RUNNER_JOIN='${url}#${code}' \\`,
    `  ${image} runner`,
  ].join('\n')
  const bare = [
    'command -v docker || curl -fsSL https://get.docker.com | sh',
    `docker run --rm -v /usr/local/sbin:/host ${image} install-host /host`,
    `colloq-host runner up ${url} ${code}${input.published ? '' : ` ${image}`}${input.classes ? ' --classes' : ''}`,
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
