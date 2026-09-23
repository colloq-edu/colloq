/**
 * Где у соревнования лежат файлы — и почему именно там.
 *
 * ГЛАВНОЕ ПРАВИЛО, из-за которого этот файл вообще существует отдельно:
 * ОТВЕТЫ НИКОГДА НЕ В WORKSPACE_DIR. Та папка монтируется в контейнеры комнат,
 * и любой студент читает её из Python тремя строками — это прямо записано в
 * SECURITY.md. Всё хозяйство соревнования живёт в DATA_DIR, рядом с базой и
 * ключами, куда контейнер занятия не смотрит.
 *
 * Раскладка одного соревнования:
 *
 *   <DATA_DIR>/competitions/<id>/
 *     data/                 открытые файлы; монтируются посылке как /data:ro
 *     secret/               solution.csv и всё, что не покидает сервер;
 *                           монтируется ТОЛЬКО контейнеру метрики
 *     baseline/             сэмпл-тетрадь преподавателя
 *     s/<submissionId>/in/  присланная тетрадь, одна, и больше ничего
 *     s/<submissionId>/out/ маячок, run.json, submission.csv, тетрадь с выводом
 *     s/<submissionId>/score/  копия ответа для контейнера метрики
 *
 * Каталогами, а не файлами, и каждый — под своим, НОВЫМ именем. Это куплено
 * опытом, а не вкусом: на colima (virtiofs) путь, у которого сменился inode,
 * продолжает отдаваться контейнеру старым. Каталог, снесённый и заведённый
 * заново под тем же именем, минуту отвечает изнутри «Directory nonexistent», а
 * одиночный файл, смонтированный `-v file:/file` и переписанный, отдаёт «No
 * such file or directory» и не чинится вовсе. Посылка при этом молча не видит
 * ни данных, ни своей тетради. Отсюда `in/`, `out/` и `score/` внутри папки
 * посылки, имя которой не повторяется никогда.
 *
 * Пути наружу отдаются через `hostPathOf`: под `make up` сервер сам сидит в
 * контейнере, и путь, по которому файл видит он, демону docker не известен —
 * ровно та же беда и то же лечение, что у комнат (kernel/pool.ts · hostMount).
 */
import path from 'node:path'
import fs from 'node:fs'
import { config } from '../config.js'
import { createAnchoredFilesystem, type HeldFile } from '../secure-files.js'

/** Корень всего хозяйства соревнований. */
export const competitionsDir = path.join(config.dataDir, 'competitions')

/**
 * Своих путей руками здесь не собирают: любая операция идёт через привязанную к
 * корню файловую систему, которая открывает каждый сегмент с O_NOFOLLOW. Имя
 * файла приходит от преподавателя, а имя соревнования — из базы; ни то ни
 * другое не повод верить строке.
 */
export const competitionsFs = createAnchoredFilesystem(competitionsDir)

/** Идентификаторы едут в путь, поэтому проверяются буквами, а не доверием. */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Имя файла данных — то, что участник увидит в `data/` и напишет в своей
 * тетради. Без путей, без точки в начале, без пробелов по краям: файл
 * `../../colloq.db` не должен даже обсуждаться.
 */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

function checkId(id: string): string {
  if (!ID_OK.test(id)) throw new Error('Competition storage: bad identifier')
  return id
}

function checkName(name: string): string {
  if (!NAME_OK.test(name) || name.includes('..')) {
    throw new Error('Competition storage: bad file name')
  }
  return name
}

/* ------------------------------------------------------------------ пути */

export function competitionDir(id: string): string {
  return path.join(competitionsDir, checkId(id))
}

/** Открытые файлы. Монтируются посылке `:ro`. */
export function openDir(id: string): string {
  return path.join(competitionDir(id), 'data')
}

/**
 * Ответы и всё, что их выдаёт.
 *
 * Отдельным каталогом рядом с открытыми файлами, а не подпапкой внутри них:
 * открытый каталог монтируется в контейнер участника целиком, и вложенный
 * «секретный» подкаталог уехал бы туда вместе с ним.
 */
export function secretDir(id: string): string {
  return path.join(competitionDir(id), 'secret')
}

export function baselineDir(id: string): string {
  return path.join(competitionDir(id), 'baseline')
}

export function submissionDir(id: string, submissionId: string): string {
  return path.join(competitionDir(id), 's', checkId(submissionId))
}

/** Вход контейнера тетради: ровно одна тетрадь, `:ro`. */
export function inputDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'in')
}

/** Host-promoted artifacts; participant containers cannot write here. */
export function resultDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'out')
}

/** Every execution owns its directories; previous results are never inputs to
 * a new notebook attempt. Only validated host exports are promoted to out/. */
export function attemptDir(id: string, submissionId: string, attemptId: string, part: 'result' | 'score' | 'score-out' | 'secret' = 'result'): string {
  return ensureDir(path.join(submissionDir(id, submissionId), 'attempts', checkId(attemptId), part))
}

export function dropAttempt(id: string, submissionId: string, attemptId: string): void {
  competitionsFs.rmSync(path.join(submissionDir(id, submissionId), 'attempts', checkId(attemptId)), { recursive: true, force: true })
}

/** Snapshot through anchored descriptors without buffering a whole dataset. */
export function copyCompetitionFile(from: string, to: string): void {
  const source = competitionsFs.openRead(from)
  let output: number | undefined
  try {
    output = competitionsFs.openSync(to, 'wx', 0o600)
    const chunk = Buffer.alloc(1024 * 1024)
    let size: number
    while ((size = fs.readSync(source.fd, chunk, 0, chunk.length, null)) > 0) {
      let offset = 0
      while (offset < size) offset += fs.writeSync(output, chunk, offset, size - offset)
    }
  } finally { source.close(); if (output !== undefined) fs.closeSync(output) }
}

export function promoteAttempt(id: string, submissionId: string, from: string, answer: Buffer): void {
  const out = ensureDir(resultDir(id, submissionId))
  // Atomic host rename: readers see the last complete successful answer.
  const temporary = path.join(out, '.answer-next')
  competitionsFs.writeFileSync(temporary, answer, { mode: 0o600 })
  competitionsFs.renameSync(temporary, path.join(out, SUBMISSION_FILE))
  publishAttemptArtifacts(id, submissionId, from)
}

/** A failed notebook still has useful current output; retain its execution
 * artifacts separately from the last successful CSV used by metric rescoring. */
export function publishAttemptArtifacts(id: string, submissionId: string, from: string): void {
  const out = ensureDir(resultDir(id, submissionId))
  for (const name of ['executed.ipynb', 'run.json']) {
    const body = readIfExists(path.join(from, name), 64 * 1024 * 1024)
    if (body) {
      const temporary = path.join(out, `.${name}-next`)
      competitionsFs.writeFileSync(temporary, body, { mode: 0o600 })
      competitionsFs.renameSync(temporary, path.join(out, name))
    } else competitionsFs.rmSync(path.join(out, name), { force: true })
  }
}

/**
 * Вход контейнера метрики: копия ответа и ничего больше.
 *
 * Своим каталогом, потому что контейнеру метрики нельзя видеть ни исполненную
 * тетрадь участника, ни её вывод: код преподавателя исполняется рядом с
 * ответами, и всё, что туда попало, может уехать в текст ошибки.
 */
export function scoreDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'score')
}

/**
 * Куда пишет контейнер метрики — СОСЕДНИМ каталогом, а не внутри `score/`.
 *
 * Тот же путь, смонтированный и на чтение (`/submission`), и на запись
 * (`/out`), выглядит снаружи одной папкой: сторож, считающий, сколько
 * контейнер написал на диск, засчитал бы туда копию ответа и убил бы метрику
 * на первой же посылке крупнее его потолка.
 */
export function scoreOutDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'score-out')
}

/** Имя присланной тетради на диске — всегда одно и то же. */
export const NOTEBOOK_FILE = 'notebook.ipynb'
/** Имя ответа по умолчанию; соревнование может назвать своё. */
export const SUBMISSION_FILE = 'submission.csv'
/** Ответы преподавателя. */
export const SOLUTION_FILE = 'solution.csv'

/**
 * Тот же путь глазами демона docker.
 *
 * Под `make run` сервер на хосте и пути совпадают. Под `make up` он сам в
 * контейнере, и `-v /data/competitions/...` отдал бы посылке пустой каталог,
 * заведённый демоном на лету, — она молча не увидела бы ни данных, ни тетради.
 * `DATA_HOST_DIR` называет ту же папку так, как её видит хост; пусто — значит
 * переводить нечего.
 */
export function hostPathOf(inside: string): string {
  const root = (process.env.DATA_HOST_DIR ?? '').trim()
  if (!root) return inside
  return path.join(root, path.relative(config.dataDir, inside))
}

/* --------------------------------------------------------------- запись */

/**
 * Режим здесь не задаётся нарочно: привязанная файловая система заводит
 * каталоги сама, своим режимом, а корень лежит внутри DATA_DIR — того самого
 * 0700, в котором уже живут ключи входа (config.ensureDataDir).
 */
function ensureDir(absolute: string): string {
  competitionsFs.mkdirSync(absolute, { recursive: true })
  return absolute
}

/** Завести каталоги соревнования. Идемпотентно: зовётся и при создании, и позже. */
export function ensureCompetition(id: string): void {
  ensureDir(openDir(id))
  ensureDir(secretDir(id))
  ensureDir(baselineDir(id))
}

/** Положить открытый файл данных. Возвращает, сколько байт записано. */
export function putOpenFile(id: string, name: string, body: Uint8Array): number {
  const file = path.join(ensureDir(openDir(id)), checkName(name))
  competitionsFs.writeFileSync(file, Buffer.from(body), { mode: 0o600 })
  return body.length
}

/**
 * Положить ответы (или что угодно ещё, чего участник видеть не должен).
 *
 * Отдельная дверь от `putOpenFile` не ради удобства: перепутать каталог — это
 * выдать ответы классу, и такая ошибка должна выглядеть как другое имя
 * функции, а не как другое значение параметра.
 */
export function putSecretFile(id: string, name: string, body: Uint8Array): number {
  const file = path.join(ensureDir(secretDir(id)), checkName(name))
  competitionsFs.writeFileSync(file, Buffer.from(body), { mode: 0o600 })
  return body.length
}

export function putBaseline(id: string, body: Uint8Array): number {
  const file = path.join(ensureDir(baselineDir(id)), NOTEBOOK_FILE)
  competitionsFs.writeFileSync(file, Buffer.from(body), { mode: 0o600 })
  return body.length
}

/**
 * Разложить присланную тетрадь под посылку.
 *
 * Каталог обязан быть новым — см. шапку файла про virtiofs. Повторный заход с
 * тем же идентификатором отказывает вслух: тихое переиспользование дало бы
 * посылку, которая видит чужую тетрадь или не видит никакой.
 */
export function putSubmissionNotebook(
  id: string,
  submissionId: string,
  body: Uint8Array,
): { input: string; result: string } {
  const dir = submissionDir(id, submissionId)
  if (competitionsFs.existsSync(dir)) {
    throw new Error(`Competition storage: submission directory already exists (${submissionId})`)
  }
  const input = ensureDir(inputDir(id, submissionId))
  const result = ensureDir(resultDir(id, submissionId))
  competitionsFs.writeFileSync(path.join(input, NOTEBOOK_FILE), Buffer.from(body), { mode: 0o600 })
  return { input, result }
}

/**
 * Каталог для контейнера метрики — заводится заново на каждый прогон.
 *
 * Пересчёт после правки метрики зовёт это второй раз, и старый каталог сносится
 * целиком: перезаписать в нём файл нельзя по той же причине, по какой не
 * монтируют одиночные файлы.
 */
export function freshScoreDir(id: string, submissionId: string, answer: Uint8Array): string {
  const dir = scoreDir(id, submissionId)
  competitionsFs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
  competitionsFs.writeFileSync(path.join(dir, SUBMISSION_FILE), Buffer.from(answer), {
    mode: 0o600,
  })
  return dir
}

/**
 * Пустой каталог под ответ метрики — тоже заново на каждый прогон.
 *
 * Режим 0777 здесь не от щедрости: каталог монтируется контейнеру, который
 * ходит от uid 1000, и файл в него кладёт он, а не мы. Тот же приём, что у
 * `/result` посылки; чужого в нём не лежит ничего — только один json,
 * прочитанный сразу после смерти контейнера.
 */
export function freshScoreOutDir(id: string, submissionId: string): string {
  const dir = scoreOutDir(id, submissionId)
  competitionsFs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
  competitionsFs.chmodSync(dir, 0o777)
  return dir
}

/* --------------------------------------------------------------- чтение */

function readIfExists(file: string, limit: number): Buffer | null {
  try {
    if (competitionsFs.statSync(file).size > limit) return null
    return competitionsFs.readFileSync(file) as Buffer
  } catch {
    return null
  }
}

/** Байты открытого файла — то, что скачивает участник. */
export function readOpenFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(openDir(id), checkName(name)), limit)
}

/** Байты ответов. Наружу это не уезжает никогда — только в контейнер метрики. */
export function readSecretFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(secretDir(id), checkName(name)), limit)
}

export function readBaseline(id: string, limit = 64 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(baselineDir(id), NOTEBOOK_FILE), limit)
}

/**
 * Что посылка оставила после себя: `progress.json`, `run.json`, ответ,
 * исполненная тетрадь. Имя проверяется тем же правилом — сюда приходит запрос
 * из браузера («Скачать тетрадь с выводом»).
 */
export function readResultFile(
  id: string,
  submissionId: string,
  name: string,
  limit = 64 * 1024 * 1024,
): Buffer | null {
  return readIfExists(path.join(resultDir(id, submissionId), checkName(name)), limit)
}

/**
 * Дескриптор файла для отдачи браузеру — БЕЗ чтения его в память.
 *
 * `train.csv` бывает в сотню мегабайт, и класс из тридцати человек скачивает
 * его в первые две минуты пары. `readOpenFile` на таком запросе держал бы
 * тридцать буферов в том же процессе, который в эту минуту ведёт занятие.
 * `openRead` отдаёт открытый inode, и дальше файл течёт мимо нас
 * (`secure-files.ts` · downloadHeldFile) — с диапазонами байт и докачкой.
 *
 * Скрытых ответов такой двери НЕТ и быть не может: `solution.csv` наружу не
 * уезжает ни по какому адресу.
 */
export function holdOpenFile(id: string, name: string): HeldFile {
  return competitionsFs.openRead(path.join(openDir(id), checkName(name)))
}

/** То же для того, что посылка оставила после себя: исполненная тетрадь, журнал. */
export function holdResultFile(id: string, submissionId: string, name: string): HeldFile {
  return competitionsFs.openRead(path.join(resultDir(id, submissionId), checkName(name)))
}

/** И для присланной тетради — она же ответ, пока прогон не дошёл до конца. */
export function holdSubmittedNotebook(id: string, submissionId: string): HeldFile {
  return competitionsFs.openRead(path.join(inputDir(id, submissionId), NOTEBOOK_FILE))
}

export function listOpenFiles(id: string): { name: string; bytes: number }[] {
  return listDir(openDir(id))
}

export function listSecretFiles(id: string): { name: string; bytes: number }[] {
  return listDir(secretDir(id))
}

function listDir(absolute: string): { name: string; bytes: number }[] {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(absolute) as string[]
  } catch {
    return []
  }
  const out: { name: string; bytes: number }[] = []
  for (const name of names) {
    try {
      out.push({ name, bytes: competitionsFs.statSync(path.join(absolute, name)).size })
    } catch {
      // Файл исчез между readdir и stat — не беда, его и не было в ответе.
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** Сколько весят открытые файлы — против потолка «до 200 МБ на соревнование». */
export function openBytes(id: string): number {
  return listOpenFiles(id).reduce((sum, file) => sum + file.bytes, 0)
}

/* --------------------------------------------------------------- уборка */

export function dropOpenFile(id: string, name: string): boolean {
  return remove(path.join(openDir(id), checkName(name)))
}

export function dropSecretFile(id: string, name: string): boolean {
  return remove(path.join(secretDir(id), checkName(name)))
}

function remove(absolute: string, recursive = false): boolean {
  try {
    if (!competitionsFs.existsSync(absolute)) return false
    competitionsFs.rmSync(absolute, { recursive, force: true })
    return true
  } catch {
    return false
  }
}

/** Снять всё, что оставила одна посылка: тетрадь, вывод, ответ. */
export function removeSubmission(id: string, submissionId: string): boolean {
  return remove(submissionDir(id, submissionId), true)
}

/**
 * Снять то, что жило ровно на время подсчёта метрики.
 *
 * Копия ответа для контейнера метрики и его json — вторая копия того же файла,
 * который уже лежит в `out/`. Держать её между прогонами значит хранить каждый
 * ответ дважды: на соревновании в триста посылок это гигабайты, которых никто
 * не читает. Пересчёт заводит каталог заново — он всё равно обязан быть новым.
 */
export function dropScoreDirs(id: string, submissionId: string): boolean {
  const answer = remove(scoreDir(id, submissionId), true)
  const out = remove(scoreOutDir(id, submissionId), true)
  return answer || out
}

/**
 * Соревнование удалили — с ним уходят данные, ответы, сэмпл-тетрадь и все
 * посылки. Ничего из этого не переживает строку в базе: ответы, оставшиеся на
 * диске от удалённого соревнования, — это ответы, за которыми больше никто не
 * следит.
 */
export function removeCompetition(id: string): boolean {
  return remove(competitionDir(id), true)
}

/**
 * Что хранится дольше самой посылки.
 *
 * Число (публичное и приватное) живёт в базе вечно — лидерборд обязан
 * сойтись и через год. Тяжёлое — исполненная тетрадь с выводом, ответ,
 * присланный файл — нужно, пока участник разбирается с неудачей, и может
 * уйти, когда соревнование давно закрыто. Здесь снимается всё, кроме
 * перечисленного в `keep`; решает, кого оставить, хранилище (store.ts), потому
 * что это вопрос к базе, а не к диску.
 */
export function pruneSubmissions(id: string, keep: ReadonlySet<string>): number {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(path.join(competitionDir(id), 's')) as string[]
  } catch {
    return 0
  }
  let dropped = 0
  for (const name of names) {
    if (keep.has(name)) continue
    if (removeSubmission(id, name)) dropped++
  }
  return dropped
}

/**
 * Подмести за путями удаления, которые об этом хранилище не знают.
 *
 * Вторая линия, ровно как у картинок вывода (blobs.ts · sweepOrphans): цена
 * ошибки несимметрична — забытая папка означает ответы удалённого
 * соревнования, лежащие на диске неограниченно долго. Живые имена приходят
 * снаружи, чтобы этот модуль не знал про базу.
 */
export function sweepOrphans(live: ReadonlySet<string>): number {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(competitionsDir) as string[]
  } catch {
    return 0
  }
  let dropped = 0
  for (const name of names) {
    if (live.has(name) || !ID_OK.test(name)) continue
    if (removeCompetition(name)) dropped++
  }
  return dropped
}
