/**
 * Расписка идущего занятия, прочитанная со стороны команд.
 *
 * Занятие ведёт супервизор (launch.ts) и оставляет расписку в каталоге
 * состояния: порт, адрес, свой pid и pid сервера. Это единственное место,
 * которое знает, что работает ПРЯМО СЕЙЧАС, — и потому единственное, откуда
 * позволено брать порт, адрес и номера процессов.
 *
 * Почему это отдельный файл, а не по месту. Читателей трое — `link`, `status`
 * и `doctor`, — и пока каждый читал по-своему, они расходились в показаниях на
 * одном экране: status называл pid супервизора «сервером», doctor тут же
 * объявлял настоящий слушатель порта «вторым Colloq» и советовал остановить
 * собственное занятие, а порт оба брали из .env, где его никто не менял.
 *
 * Три вещи здесь НЕ делаются, и каждая намеренно.
 *
 * Не берётся порт из .env. Вопросы разные: .env говорит, что настроено,
 * расписка — на чём идёт занятие. `colloq run --port 4100` .env не трогает
 * (launch-config.ts · launchConfig), и совпадают эти два ответа только по
 * случайности.
 *
 * Не считается «жив ли»: это вопрос к процессам, а модули групп к ним не
 * ходят — только через ctx.sh. Здесь лежит то, что написано в файле, и
 * проверка живости остаётся за тем, кто спрашивает.
 *
 * Не читается расписка ЧУЖОГО корня. Путь один — ctx.env.paths.sessionFile, и
 * он посчитан от каталога состояния. Выписанный руками относительный путь
 * ровно этим и был сломан: команды искали расписку рядом с приложением.
 */
import type { Io } from './env.js'

/** То из расписки, что нужно командам. Остальные поля читает сам супервизор. */
export interface Session {
  /** Супервизор: его завершение и есть конец занятия. */
  pid: number
  /** Сервер — ребёнок супервизора. Это он слушает порт. */
  serverPid: number | null
  port: number
  url: string
  runId: string
  mode: 'run' | 'dev'
  phase: 'preparing' | 'starting' | 'ready' | 'stopping'
  startedAt: number
  /** Файл расписки на временный публичный адрес; пустая строка — нет такого. */
  leaseFile: string
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 ? value : null
}

/**
 * Локальный адрес из расписки — и он же проверка, что файл наш.
 *
 * Требования те же, что были у sessionAddress в группе local: только http,
 * только петля, без пользователя, пароля, запроса и пути. Расписку пишет свой
 * же супервизор, но она лежит в обычном файле, и ссылка из неё попадает
 * человеку на экран — значит принимается не всякая.
 */
function loopback(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:') return null
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
    if (url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== '/') return null
    return value
  } catch {
    return null
  }
}

/** Расписка или null: нет файла, битый файл и чужой формат — одинаково null. */
export function readSession(io: Io, file: string): Session | null {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(io.readText(file) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const pid = whole(data.pid)
  const url = loopback(data.url)
  const port = whole(data.port)
  const mode = data.mode === 'dev' ? 'dev' : data.mode === 'run' ? 'run' : null
  if (pid === null || url === null || port === null || port > 65535 || mode === null) return null
  if (typeof data.runId !== 'string' || !data.runId) return null
  const phase = ['preparing', 'starting', 'ready', 'stopping'].includes(String(data.phase))
    ? (data.phase as Session['phase'])
    : 'ready'
  return {
    pid,
    serverPid: whole(data.serverPid),
    port,
    url,
    runId: data.runId,
    mode,
    phase,
    startedAt: whole(data.startedAt) ?? 0,
    leaseFile: typeof data.leaseFile === 'string' ? data.leaseFile : '',
  }
}
