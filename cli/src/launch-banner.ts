import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Что человек видит, когда занятие поднялось, — одним блоком и одной ссылкой.
 *
 * Было: лог сборки ядра, строки сервера с отметками времени, рамка «nobody
 * owns this Colloq yet» посреди них и в самом конце «Panel: …/admin» — адрес,
 * по которому открывался экран входа, а не панель. Браузер открывался туда
 * же, и преподаватель на своём же компьютере первым делом искал токен.
 *
 * Теперь ссылка несёт токен установки, как у Jupyter: `/admin/t/<токен>` на
 * свежей установке открывает «стать владельцем» с уже вписанным ключом, а
 * потом просто входит (web/src/admin/entry.ts). Страница сразу стирает ключ из
 * адресной строки — проектор его не покажет. Всё, что пишут сервер и сборка,
 * уходит в журнал; на экран журнал попадает только хвостом и только при сбое.
 */

/** Ссылка входа преподавателя; без токена на диске — просто панель. */
export function teacherLink(url: string, dataDir: string): string {
  try {
    const token = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim()
    // Тот же алфавит, что принимает entry.ts: иначе ссылка вела бы на пустую панель.
    if (/^[A-Za-z0-9_-]{1,128}$/.test(token)) return `${url}/admin/t/${token}`
  } catch {
    /* Токена ещё нет или файл закрыт — войти можно и из панели. */
  }
  return `${url}/admin`
}

/** Путь от домашнего каталога — короче и читается глазами. */
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
 * Последние строки журнала — то, что раньше человек видел «выше» на экране.
 * Коды цвета и возвраты каретки срезаны: docker пишет их и в файл.
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
