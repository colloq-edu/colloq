/**
 * Пути внутри папки семинара — одни правила для браузера и для сервера.
 *
 * До сих пор папка была плоской: проверка имени на сервере отвергала всё, где
 * есть разделитель, и этого хватало ровно до того дня, когда в комнате
 * понадобился `src/model.py`. Разделитель разрешён — а значит, всё, что он
 * приносит с собой, надо назвать по именам: `..`, абсолютный путь, пустой
 * сегмент, `.` посередине, глубина, при которой дерево перестаёт помещаться в
 * панель, и длина, при которой файловая система откажет сама.
 *
 * Модуль общий, потому что проверка нужна в двух местах и обязана быть одной.
 * Сервер отказывает — это граница. Браузер отказывает раньше, чтобы человек
 * увидел «так нельзя» в поле ввода, а не после круга по сети. Разойдясь, эти
 * две проверки дают худший из возможных видов ошибки: панель уверена, что имя
 * годится, сервер молча его не принимает.
 *
 * Ни одного имени не чинит и не переименовывает: имя либо годится, либо
 * отвергается целиком. Тихо поправленное имя — это файл, который человек потом
 * не найдёт там, где положил.
 *
 * Разделители — другое дело, и это единственное исключение, названное вслух:
 * `a//b` и `data/` приводятся к канонической форме (`normalizePath`). Ни один
 * сегмент от этого не меняется — меняется только запись пути, а по протоколу и
 * в ключах он ходит в одном виде. Разрешать двум записям одного пути гулять по
 * коду хуже: `parentOf('data/')` — это `data`, и дерево получило бы папку
 * внутри самой себя.
 */

/** Сегментов в глубину. Восемь — это `a/b/c/d/e/f/g/файл`, и дерево ещё читаемо. */
export const MAX_DEPTH = 8
/** Длина одного имени. Дальше начинают отказывать сами файловые системы. */
export const MAX_SEGMENT = 120
/** Длина всего пути. С запасом под 255 у ext4 и 1024 у macOS вместе с корнем. */
export const MAX_PATH = 400

/*
 * Управляющий символ в имени законен в POSIX и вреден везде остальном: перевод
 * строки разрывает строку списка надвое, возврат каретки прячет хвост имени в
 * терминале, и ни то ни другое не переживает `pd.read_csv`. Тот же довод, что
 * и у имён участников.
 */
// eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Годится ли одно имя — файла или папки.
 *
 * Точка в начале отвергается, и это не про безопасность, а про честность:
 * скрытые файлы не показываются в дереве, и принять `.env`, а потом никогда
 * его не показать — хуже, чем сказать «нет» сразу. Тем же правилом из списка
 * выпадают `.ipynb_checkpoints` и `.git`, которые заводит не человек.
 */
export function safeSegment(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.length > MAX_SEGMENT) return false
  if (name.startsWith('.')) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (CONTROL.test(name)) return false
  // Пробел на конце — имя, которое невозможно набрать и трудно заметить.
  if (name !== name.trim()) return false
  return true
}

/**
 * Привести путь к каноническому виду или отвергнуть его.
 *
 * Возвращает путь без ведущего и хвостового слеша, с одинарными разделителями
 * — форма, в которой пути ходят по протоколу и лежат в ключах. Корень папки
 * семинара — пустая строка; она допустима как РОДИТЕЛЬ (создать файл в корне),
 * но не как цель, поэтому `normalizePath('')` возвращает пустую строку, а не
 * null, и звать её надо там, где корень имеет смысл.
 *
 * Что канонизируется, названо здесь целиком, чтобы «маленькое исправление»
 * имени не сослалось однажды на эту строчку: ПУСТЫЕ СЕГМЕНТЫ. `a//b` — это
 * `a/b`, `data/` — это `data`. Больше ничего: ни один сегмент не правится, не
 * обрезается и не переименовывается — не подошёл, и весь путь отвергнут
 * (`safeSegment`). Разница между этими двумя вещами и есть всё правило модуля:
 * запись пути ничего не говорит о том, где окажется файл, а имя говорит.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length > MAX_PATH) return null
  /*
   * Абсолютный путь отвергается, а не срезается до относительного.
   *
   * Срезать было бы соблазнительно — `/etc/passwd` превратился бы в папку
   * `etc` внутри семинара и никуда бы не убежал, — но это ровно то тихое
   * исправление имени, которого этот модуль не делает нигде: человек, набравший
   * `/data/train.csv`, имел в виду файл на машине, а получил бы новую папку и
   * пустоту в ней.
   */
  if (raw.startsWith('/') || raw.startsWith('\\')) return null
  const parts = raw.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return ''
  if (parts.length > MAX_DEPTH) return null
  for (const part of parts) if (!safeSegment(part)) return null
  return parts.join('/')
}

/** Путь папки, в которой лежит `path`. Корень — пустая строка. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** Имя без папок. */
export function baseOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}

/** Расширение в нижнем регистре, без точки. У файла без точки — пустая строка. */
export function extOf(path: string): string {
  const base = baseOf(path)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

/** Лежит ли `path` внутри папки `dir` (или это она сама). */
export function isInside(path: string, dir: string): boolean {
  if (dir === '') return true
  return path === dir || path.startsWith(dir + '/')
}

/**
 * Соединить папку и имя. Ни то ни другое здесь не проверяется — результат
 * всё равно проходит `normalizePath` там, где им пользуются.
 */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/**
 * Почему имя не годится — фразой, с которой человек может что-то сделать.
 *
 * `safeSegment` отвечает «да» или «нет», и этого хватает серверу и не хватает
 * никому больше: «недопустимое имя» посреди пары не говорит ни какое, ни чем
 * оно плохо.
 */
export function whySegmentRefused(name: string): string {
  const shown = name.slice(0, 60) || '(пусто)'
  if (!name) return 'Имя не может быть пустым.'
  if (name === '.' || name === '..') return 'Так называется не файл, а место в дереве.'
  if (name.includes('/') || name.includes('\\')) {
    return `В «${shown}» есть косая черта — папку заводят отдельной кнопкой.`
  }
  if (CONTROL.test(name)) return `В «${shown}» есть символы, которых не бывает в именах файлов.`
  if (name.startsWith('.')) {
    return `«${shown}» начинается с точки — такие файлы не показываются в дереве.`
  }
  if (name !== name.trim()) return `У «${shown}» пробел с краю — его потом не видно и не набрать.`
  if (name.length > MAX_SEGMENT)
    return `Имя длиной ${name.length} символов — оставьте ${MAX_SEGMENT}.`
  return `«${shown}» не годится в качестве имени.`
}

/* ------------------------------------------------------------------- вид */

/**
 * Чем файл окажется на экране.
 *
 * `text` — открывается в редакторе. `notebook` — тетрадь, и её редактор не
 * трогает: у комнаты одна тетрадь, и открывать вторую в виде JSON значит
 * предлагать её править руками. `pdf` и `image` — смотрят. `binary` — только
 * скачать.
 *
 * Список расширений, а не угадывание по содержимому: угадывание ошибается
 * ровно на тех файлах, которые студент только что создал и ещё не наполнил.
 */
export type FileKind = 'text' | 'notebook' | 'pdf' | 'image' | 'binary'

const TEXT_EXT = new Set([
  'py',
  'pyi',
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'sh',
  'bash',
  'zsh',
  'sql',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'svg',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'java',
  'go',
  'rs',
  'rb',
  'lua',
  'r',
  'jl',
  'tex',
  'bib',
  'env',
  'gitignore',
  'dockerfile',
  'log',
])

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])

/** Файлы без расширения, которые всё равно текст. */
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'readme', 'license', 'requirements'])

export function kindOf(path: string): FileKind {
  const ext = extOf(path)
  if (ext === 'ipynb') return 'notebook'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  if (!ext && TEXT_NAMES.has(baseOf(path).toLowerCase())) return 'text'
  return 'binary'
}

/**
 * Чем файл запускается — или ничем.
 *
 * Ровно два способа, и оба уже есть в комнате: `python` и оболочка контейнера.
 * Ничего третьего сюда добавлять не надо, пока в образе не появится третий
 * язык, — кнопка «Запустить», которая зовёт несуществующий интерпретатор, ведёт
 * себя как поломка.
 */
export function runnerFor(path: string): 'python' | 'shell' | null {
  const ext = extOf(path)
  if (ext === 'py') return 'python'
  if (ext === 'sh' || ext === 'bash') return 'shell'
  return null
}

/**
 * Язык для подсветки. Имя из набора CodeMirror, который грузит редактор.
 *
 * `null` — подсветки нет, и это нормально: .csv и .log читаются как текст, а
 * грамматика, натянутая не на тот язык, красит хуже, чем не красит вовсе.
 */
export type Highlight = 'python' | 'markdown' | 'json' | 'yaml' | 'javascript' | 'css' | 'html'

export function highlightFor(path: string): Highlight | null {
  const ext = extOf(path)
  if (ext === 'py' || ext === 'pyi') return 'python'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'json' || ext === 'jsonl' || ext === 'ipynb') return 'json'
  if (ext === 'yaml' || ext === 'yml') return 'yaml'
  if (
    ext === 'js' ||
    ext === 'mjs' ||
    ext === 'cjs' ||
    ext === 'ts' ||
    ext === 'tsx' ||
    ext === 'jsx'
  ) {
    return 'javascript'
  }
  if (ext === 'css' || ext === 'scss') return 'css'
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg') return 'html'
  return null
}
