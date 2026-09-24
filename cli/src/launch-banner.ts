import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * What a person sees once the class is up: one block and one link.
 *
 * It used to be: the kernel build log, server lines with timestamps, the
 * "nobody owns this Colloq yet" frame in the middle of them, and at the very
 * end "Panel: …/admin", an address that opened the sign-in screen, not the
 * panel. The browser opened there too, and the teacher, on their own
 * computer, first of all went looking for the token.
 *
 * Now the link carries the setup token, as with Jupyter: `/admin/t/<token>` on
 * a fresh install opens "become the owner" with the key already filled in, and
 * afterwards simply signs in (web/src/admin/entry.ts). The page immediately
 * erases the key from the address bar, so the projector will not show it.
 * Everything the server and the build write goes to the log; the log reaches
 * the screen only as a tail and only on a failure.
 */

/** The teacher's sign-in link; with no token on disk, just the panel. */
export function teacherLink(url: string, dataDir: string): string {
  try {
    const token = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim()
    // The same alphabet that entry.ts accepts: otherwise the link would lead to an empty panel.
    if (/^[A-Za-z0-9_-]{1,128}$/.test(token)) return `${url}/admin/t/${token}`
  } catch {
    /* No token yet, or the file is closed: one can sign in from the panel too. */
  }
  return `${url}/admin`
}

/** A path from the home directory: shorter and easier to read. */
export function tilde(file: string, home = os.homedir()): string {
  return home && (file === home || file.startsWith(home + path.sep))
    ? '~' + file.slice(home.length)
    : file
}

export interface Banner {
  link: string
  workspaceDir: string
  logFile: string
  detached: boolean
  version?: string
}

export function renderBanner(banner: Banner, home = os.homedir()): string[] {
  const title =
    (banner.version ? `Colloq ${banner.version} is running` : 'Colloq is running') +
    (banner.detached ? ' in the background' : '')
  return [
    '',
    `  ${title}`,
    '',
    `    ${banner.link}`,
    '',
    '  The link signs you in as the teacher. Keep it to yourself: students get',
    '  the /s/… link of a class, which the panel gives you.',
    '',
    `  Files  ${tilde(banner.workspaceDir, home)}`,
    `  Log    ${tilde(banner.logFile, home)}`,
    '',
    banner.detached
      ? '  colloq logs shows the log, colloq stop saves the work and stops the class.'
      : '  Ctrl+C saves the work and stops the class.',
    '',
  ]
}

/**
 * The last lines of the log: what a person used to see "above" on the screen.
 * Colour codes and carriage returns are cut: docker writes them to the file too.
 */
export function logTail(logFile: string, lines = 25): string[] {
  let text: string
  try {
    const fd = fs.openSync(logFile, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, 64 * 1024)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      text = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() !== '')
    .slice(-lines)
}
