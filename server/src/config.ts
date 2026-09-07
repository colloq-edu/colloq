import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/*
 * Anchored to this file rather than to process.cwd(). These two defaults used
 * to be resolve(cwd, '../workspace') and '../data', which are only right when
 * the process was started from server/: launched from the repo root instead,
 * the server silently created a workspace directory *beside* the repo and then
 * listed that, while the kernel container kept writing into the real one — a
 * cell would report success and its file would never appear.
 *
 * src/config.ts and the bundled dist/server.js both sit two levels under the
 * root, so one expression covers dev and a local production build. The
 * container sets DATA_DIR and WORKSPACE_DIR explicitly and never gets here.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = path.resolve(env('DATA_DIR', path.join(repoRoot, 'data')))
const workspaceDir = path.resolve(env('WORKSPACE_DIR', path.join(repoRoot, 'workspace')))

/**
 * Каталог данных — 0700, и это единственное место, где так сказано.
 *
 * Внутри лежат ключи входа преподавателей, ключ модели инстанса и токен
 * установки. Заводили каталог трое — этот модуль, db.ts и admin/auth.ts, — и
 * `mode` стоял только у одного из них; а `mkdirSync(mode)` на уже
 * существующем каталоге не делает НИЧЕГО. Побеждал тот, кто позвал первым,
 * и это всегда config.ts (он грузится раньше db.ts): каталог выходил 0755 при
 * комментарии в db.ts, обещающем «0700, закрытый для всех». Сами файлы 0600,
 * так что утечки не было, — но обещание в коде должно быть правдой, иначе
 * следующий класть сюда что-то менее осторожное будет верить ему.
 *
 * chmod отдельно от mkdir: он-то и чинит каталог, заведённый прошлой версией
 * (и `make dirs`, который заводит его до нас). В try — на общей папке, чужой
 * по владельцу, chmod откажет, и это не повод не запуститься.
 */
export function ensureDataDir(): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dataDir, 0o700)
  } catch {
    /* не наш каталог — работаем как есть, файлы всё равно 0600 */
  }
  return dataDir
}

/*
 * The signing key outlives the process.
 *
 * It used to be `crypto.randomBytes(24)` per boot, which is fine for a service
 * nobody is sitting in and wrong for this one: the key signs participant
 * tokens, so restarting the server mid-seminar invalidated every token in the
 * room at once. Every student's socket was refused from then on — no error, no
 * reconnect, just a room that had gone quiet — and each of them had to reload
 * and retype their name, arriving as a new person with a new colour. The owner
 * was signed out of the panel in the same instant.
 *
 * A crash, `docker compose restart` and a deploy all land here, so the key is
 * generated once and kept. 0600 at creation rather than a chmod afterwards:
 * there must be no moment when it is readable and already holds the secret.
 * SESSION_SECRET still wins when it is set, which is how you rotate it — or
 * share one key across several replicas.
 */
function persistedSecret(): string {
  const file = path.join(dataDir, 'session-secret')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* first boot, or the file was removed to force a rotation */
  }
  const secret = crypto.randomBytes(32).toString('hex')
  ensureDataDir()
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
  return secret
}

/*
 * Адрес, по которому комнату видно снаружи, — перечитываемый.
 *
 * Он был константой, прочитанной один раз при запуске, и `make host` этим
 * пользовался наоборот: при Ctrl+C скрипт возвращает PUBLIC_URL в .env на
 * localhost, а живой сервер продолжает раздавать https-ссылку на туннель,
 * которого уже нет. Преподаватель копирует адрес из панели и рассылает его
 * группе — адрес не открывается ни у кого, включая его самого.
 *
 * Файл перечитывается не чаще раза в две секунды: спрашивают его на каждой
 * ссылке в списке семинаров, а меняется он дважды за жизнь процесса.
 */
const envFile = path.join(repoRoot, '.env')
let publicUrlCache: { at: number; value: string } | null = null

function readPublicUrl(): string {
  const fallback = `http://localhost:${env('PORT', '3000')}`
  const now = Date.now()
  if (publicUrlCache && now - publicUrlCache.at < 2000) return publicUrlCache.value

  /*
   * Файл главнее переменной окружения — и это не описка.
   *
   * Сначала было наоборот, «как обычно», и от этого не работало ровно то, ради
   * чего всё затевалось: `make run` и `scripts/host.sh` перед запуском node
   * делают `set -a; . ./.env`, так что PUBLIC_URL всегда уже в process.env — и
   * файл, который host.sh правит при Ctrl+C, не перечитывался никогда.
   *
   * В контейнере .env рядом нет (образ его не копирует), а PUBLIC_URL приходит
   * через compose — там читается переменная, как и раньше. То есть правило
   * простое: где файл есть, он и главный; где нет — окружение.
   */
  let value = ''
  try {
    const line = fs
      .readFileSync(envFile, 'utf8')
      .split('\n')
      .reverse()
      .find((l) => /^\s*PUBLIC_URL\s*=/.test(l))
    if (line) value = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')
  } catch {
    /* .env нет — это норма */
  }
  if (!value) value = process.env.PUBLIC_URL ?? ''
  const resolved = (value || fallback).replace(/\/+$/, '')
  publicUrlCache = { at: now, value: resolved }
  return resolved
}

/**
 * Токен Jupyter из .env.example — то есть известный всем, кто видел репозиторий.
 *
 * Умолчание нужно: без него `make run` на ноутбуке не поднялся бы вовсе. Но оно
 * же — пароль к контейнеру с файлами всех семинаров: `make up` при создании
 * .env выписывает случайный, а `cp .env.example .env` руками или .env, лежащий
 * с прошлой весны, оставляют этот. Ради одной строки предупреждения при старте
 * (`server/src/index.ts` · announceJupyterToken) значение названо здесь, а не
 * повторено вторым литералом на другом конце процесса.
 */
export const DEV_JUPYTER_TOKEN = 'colloq-dev-token'

export const config = {
  port: Number(env('PORT', '3000')),
  get publicUrl(): string {
    return readPublicUrl()
  },

  /** Signs participant tokens, host tokens and the staff cookie. See sessionSecret(). */
  // `||` rather than a fallback argument: persistedSecret() writes a file, and
  // an install that sets the key explicitly should not have one made for it.
  sessionSecret: env('SESSION_SECRET', '') || persistedSecret(),

  dataDir,
  workspaceDir,
  /** Built frontend, served by this process in production. Empty in dev (Vite serves it). */
  staticDir: env('STATIC_DIR', ''),

  jupyter: {
    url: env('JUPYTER_URL', 'http://localhost:8888').replace(/\/+$/, ''),
    token: env('JUPYTER_TOKEN', DEV_JUPYTER_TOKEN),
  },

  /**
   * Организация, развернувшая инстанс: строка рядом с логотипом на каждом
   * экране. На одном адресе это университет, на другом банк, на третьем не
   * нужно ничего — поэтому умолчание пусто, и тогда логотип остаётся одним
   * словом, без разделительной линейки.
   *
   * Восемьдесят символов — тот же потолок, что у названия модели в правилах
   * комнаты (shared/rules.ts). Обрезается здесь, а не в вёрстке, потому что
   * цена длинной строки не только в шапке: она едет в каждом ответе про
   * семинар и ложится в localStorage каждого браузера как часть карточки
   * комнаты. В шапке она к тому же стоит в одну линию с логотипом и забирает
   * себе всю оставшуюся ширину — многоточие спасает вёрстку, но название
   * семинара рядом с абзацем всё равно остаётся ни с чем. Прежняя зашитая
   * строка была в сорок четыре символа; восемьдесят — вдвое больше любого
   * настоящего имени и всё ещё строка, а не абзац.
   */
  institution: env('INSTITUTION', '').trim().slice(0, 80),

  /**
   * Prefills the claim form on a fresh instance. It is a suggestion, not a
   * credential: the setup token is what proves ownership, and the owner can
   * type any address. Empty is fine — the form just starts blank.
   */
  adminEmail: env('ADMIN_EMAIL', ''),

  /**
   * Whether anyone may create a seminar through the API — POST /api/sessions
   * with no staff cookie. There is no screen for it: `/` goes to the panel, so
   * this is a switch for scripting.
   *
   * Off by default now that there is a staff list: an open instance means any
   * visitor can spin up a room and spend the owner's API key. The line above
   * used to promise a home screen with a "create a seminar" button on it — the
   * screen was taken out and the promise stayed, so the flag read as a way to
   * bring an interface back rather than as what it is.
   */
  openSeminarCreation: env('OPEN_SEMINAR_CREATION', 'false') === 'true',

  ai: {
    provider: env('AI_PROVIDER', 'openai'),
    apiKey: env('OPENAI_API_KEY', ''),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    /**
     * Просить ли у модели её рассуждение отдельным полем.
     *
     * Выключено. Было «всегда на OpenRouter», и это тихо удваивало счёт: у
     * рассуждающих моделей след стоит как ответ, а иногда дороже, и его
     * просили на каждый вопрос — включая «объясни эту ошибку», где думать не о
     * чем. След всё равно виден, когда провайдер отдаёт его сам; здесь только
     * про то, доплачивать ли за него.
     */
    reasoning: env('AI_REASONING', 'false') === 'true',
  },

  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '50')) * 1024 * 1024,

  /**
   * Потолок на всю комнату, а не на один файл.
   *
   * Ограничение было только на файл: пятьдесят мегабайт за раз и сто заходов
   * дают пять гигабайт на одном семинаре. Диск здесь общий с базой, снимками
   * тетрадей и образами окружений, и кончается он молча и сразу для всех.
   * Гигабайт — это двадцать предельных файлов; настоящему семинару столько не
   * нужно, а промахнувшемуся ногой по клавише хватит, чтобы остановиться.
   */
  maxSessionBytes: Number(env('MAX_SESSION_MB', '1024')) * 1024 * 1024,

  /** How often an idle-but-dirty document is written to disk. */
  snapshotIntervalMs: 1500,
  /** Coalescing window for kernel stdout/stderr before it hits the CRDT. */
  outputFlushMs: 50,

  /*
   * How long a kernel may say nothing before this server asks Jupyter whether
   * it is still alive — see JupyterKernel.confirmAlive(). Settable because the
   * test that covers a kernel dying silently would otherwise spend fifteen
   * seconds waiting for the room to notice; nothing else has a reason to touch
   * these.
   */
  kernelQuietMs: Number(env('KERNEL_QUIET_MS', '10000')),
  kernelWatchdogMs: Number(env('KERNEL_WATCHDOG_MS', '5000')),
} as const

export const aiEnabled = () => config.ai.apiKey.length > 0
