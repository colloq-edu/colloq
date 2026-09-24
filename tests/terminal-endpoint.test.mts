/**
 * Where the shared terminal goes.
 *
 * The Jupyter address is a property of the room, not of the process: that is
 * why two seminars can sit on different Pythons at the same time. The kernel
 * honoured this from the very appearance of environments, while the terminal
 * read the global setting — and in a seminar with a chosen environment
 * `pip install` went into a container this room's Python does not see. The
 * command ran, wrote "successfully installed" and changed nothing that could
 * be imported from a cell.
 *
 * The check goes by the source, not by behaviour, and this is deliberate: to
 * catch this bug coming back at run time, you need two live Jupyter containers
 * and a terminado socket to each — that is, a check that will not be in CI and
 * will not run on a laptop without Docker. And the whole bug is in one line:
 * the address was taken from the wrong place. Such a line is visible by
 * reading.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

test('the terminal does not read the Jupyter address from the instance settings', () => {
  const source = read('server/src/kernel/terminal.ts')
  const offenders = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => line.includes('config.jupyter'))

  assert.deepEqual(
    offenders,
    [],
    `the terminal takes the address from config.jupyter again — in a room with its own environment ` +
      `it will go into someone else's container:\n` +
      offenders.map(({ no, line }) => `  terminal.ts:${no}  ${line}`).join('\n'),
  )
})

test('the terminal asks the room itself for the address', () => {
  const source = read('server/src/kernel/terminal.ts')
  assert.ok(
    source.includes('endpointForSession(sessionId,'),
    'the terminal must resolve the address through the room container, as the kernel does',
  )
})

test('the kernel and the terminal resolve the address the same way', () => {
  /*
   * Two subsystems, one rule. If one of them ever starts computing the address
   * its own way, they will drift apart silently: both will keep working, just
   * in different containers, and the one to notice is a student whose import
   * cannot find a package that was just installed.
   */
  const kernel = read('server/src/kernel/index.ts')
  const terminal = read('server/src/kernel/terminal.ts')

  /*
   * The rule is checked, not the letter.
   *
   * Previously the exact expression
   * `endpointForEnvironment(sessionEnvironment(sessionId))` stood here, and the
   * test broke on an edit that changed nothing in meaning: the environment
   * name was needed a second time — to forget a stale address on a refusal —
   * and moved into a variable. The rule itself stayed the same, but the check
   * did not survive it.
   */
  for (const [name, source] of [
    ['the kernel', kernel],
    ['the terminal', terminal],
  ] as const) {
    /*
     * One room — one container, and the shell must get into the same one
     * where the cells are computed: `!pip install` in the terminal and
     * `import` in a cell must talk about the same Python. Previously the rule
     * was "through the environment"; now it is stricter — through the room
     * itself.
     */
    assert.ok(
      source.includes('endpointForSession(sessionId,'),
      `${name} no longer resolves the address through the room container`,
    )
    assert.ok(
      source.includes('sessionEnvironment(sessionId)'),
      `${name} no longer asks the seminar for its environment`,
    )
    /*
     * There is no check on defaultEndpoint() here, and this is deliberate: in
     * terminal.ts it stands as a placeholder in a freshly created record,
     * before the terminal was ever opened. The real address is asked for in
     * openTerminal. A ban on the mere mention would catch this line and
     * improve nothing.
     */
  }
})

test('a change of address invalidates the remembered pty name', () => {
  /*
   * A pty named "1" exists in every container. Having remembered the name
   * from one and connected with it to another, the terminal would lead the
   * room into someone else's shell — not its own, but not into nothing
   * either, which is worse than an error.
   */
  const source = read('server/src/kernel/terminal.ts')
  assert.ok(
    /if \(endpointIdentity\(endpoint\) !== endpointIdentity\(term\.endpoint\)\) term\.name = null/.test(source),
    'the pty name must be reset when the address or the Pod UID changes',
  )
})

test('incarnation identity changes when a Pod is replaced behind the same Service URL', async () => {
  await import('./_env.mts')
  const { endpointIdentity } = await import('../server/src/kernel/jupyter.js')
  const first = { url: 'http://room.colloq.svc:8888', token: 'private', instanceId: 'uid-one' }
  assert.notEqual(endpointIdentity(first), endpointIdentity({ ...first, instanceId: 'uid-two' }))
  assert.equal(endpointIdentity(first), endpointIdentity({ ...first, token: 'rotated' }))
})
