import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { messages } from '../shared/i18n'
import type { Locale, MessageCatalog } from '../shared/i18n-types'
import { commonMessages } from '../shared/locales/common'
import { roomMessages } from '../shared/locales/room'
import { adminMessages } from '../shared/locales/admin'
import { serverMessages } from '../shared/locales/server'
import { activityMessages } from '../shared/locales/activity'
import { collectEntryMessages, collectClientKeys } from './scripts/entry-messages'

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000'
const LOCALES: readonly Locale[] = ['ru', 'en']

/** Server imports keep all catalogs; browser entry carries only its own copy. */
function entryLanguage(): Plugin {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const shared = path.join(root, 'shared/i18n')
  const browser = path.join(root, 'web/src/lib/i18n-browser.ts')
  const virtual = 'virtual:colloq-entry-messages'
  return {
    name: 'colloq-entry-language',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === virtual) return '\0' + virtual
      const resolved = source.startsWith('.') && importer
        ? path.resolve(path.dirname(importer), source) : source
      if (source === '@shared/i18n' || resolved.replace(/\.(?:js|ts)$/, '') === shared) return browser
    },
    load(id) {
      if (id !== '\0' + virtual) return
      const entry = collectEntryMessages(root, messages)
      for (const file of entry.files) this.addWatchFile(file)
      return `export default ${JSON.stringify(entry.messages)}`
    },
  }
}

/**
 * Словарь экрана: одна область, один язык.
 *
 * Он был один на всех — `full-language`, 351 КБ исходника и 74 КБ по проводу,
 * и приезжал ПЕРЕД любым экраном. В нём лежали оба языка, весь каталог панели
 * преподавателя и весь серверный, из которых браузер умеет искать три десятка
 * ключей. Комнате на одном языке нужно 80 КБ.
 *
 * Настоящие файлы lib/messages/<область>-<язык>.ts остаются на диске: их
 * грузят node и тесты, и они же — единственное место, где записан СОСТАВ
 * области. Здесь их содержимое подменяется на сборочное: те же каталоги,
 * прочитанные из их собственных импортов, но один язык и урезанный `server`.
 */
function screenLanguage(): Plugin {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const folder = path.join(root, 'web/src/lib/messages')
  const catalogs: Record<string, MessageCatalog> = {
    common: commonMessages,
    room: roomMessages,
    admin: adminMessages,
    server: serverMessages,
    activity: activityMessages,
  }
  /*
   * Серверный каталог — единственный, который режется по ключам, а не целиком.
   *
   * Почти весь он никогда не доезжает до браузера: это страницы публикации,
   * письма и журнал. Клиент переводит серверные СЛОВА состояния («ядро занято»)
   * и несколько имён по умолчанию, и все они записаны в его исходниках
   * буквально — отсюда и считаются. Ошибки приходят уже переведёнными
   * сервером и проходят через tr() нетронутыми, словаря им не нужно.
   */
  let client: Set<string> | null = null
  return {
    name: 'colloq-screen-language',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0]
      if (path.dirname(file) !== folder || !file.endsWith('.ts')) return
      const [area, locale] = path.basename(file, '.ts').split('-')
      if (!area || !LOCALES.includes(locale as Locale)) {
        throw new Error(`colloq-screen-language: ${file} — имя вида <область>-<ru|en>.ts`)
      }
      const source = fs.readFileSync(file, 'utf8')
      const wanted = [...source.matchAll(/@shared\/locales\/([a-z]+)/g)].map((match) => match[1])
      if (wanted.length === 0) throw new Error(`colloq-screen-language: в ${file} нет каталогов`)
      client ??= collectClientKeys(root, messages, 'server')
      const out: Record<string, Record<string, unknown>> = {}
      for (const name of wanted) {
        const catalog = catalogs[name]
        if (!catalog) throw new Error(`colloq-screen-language: неизвестный каталог ${name}`)
        this.addWatchFile(path.join(root, 'shared/locales', `${name}.ts`))
        for (const [key, pair] of Object.entries(catalog)) {
          if (name === 'server' && !client.has(key)) continue
          out[key] = { [locale]: pair[locale as Locale] }
        }
      }
      return "import { registerMessages } from '@shared/i18n-runtime'\n" +
        `registerMessages(${JSON.stringify(out)})\n`
    },
  }
}

/* ------------------------------------------------------------------ chunks */

/*
 * One chunk per heavy vendor. Two payoffs: a student who opens '/' never
 * downloads the editor, the markdown renderer or the ANSI parser, and a
 * student who comes back next week revalidates only the chunks that actually
 * changed instead of one monolith whose hash moves on every app edit.
 *
 * On /s/:id a cold visitor gets the join form first, then warms the editor
 * while entering their name — see firstPaint below.
 */
const CODEMIRROR = /^(@codemirror\/|@lezer\/|y-codemirror\.next$|style-mod$|w3c-keyname$|crelt$)/
const YJS = /^(yjs|y-websocket|y-protocols|y-indexeddb|lib0)$/
/* marked, DOMPurify and ansi_up are loaded together by lib/render.svelte.ts and
   are useless apart, so they ship as one chunk rather than three requests. */
const RENDER = /^(marked|dompurify|ansi_up)$/
/* pdf.js приезжает только когда в комнате открыли документ; воркер к нему идёт
   мимо сборщика, отдельным файлом из public/ — см. lib/pdf.svelte.ts. */
const PDF = /^pdfjs-dist$/

const NODE_MODULES = 'node_modules/'

/** The npm package a module id belongs to, scope included. */
function packageOf(id: string): string | null {
  const at = id.lastIndexOf(NODE_MODULES)
  if (at === -1) return null
  const [first = '', second = ''] = id.slice(at + NODE_MODULES.length).split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

/**
 * Имя куска комнаты — то, которым его называет Rollup: базовое имя модуля.
 *
 * Своего куска SessionScreen не просит и не должен: он и так уезжает в
 * отдельный, потому что грузится динамическим `import()`. Просить его через
 * `manualChunks` пробовали — и это ХУЖЕ: назначенный вручную кусок утаскивает
 * за собой то, что нужно и входу тоже, и в собранном index.js появляется
 * СТАТИЧЕСКИЙ импорт из него. То есть 457 КБ комнаты начинают качаться на
 * экране входа — ровно то, ради чего экран и разделяли.
 *
 * Имя нужно здесь одному: `firstPaint` ниже кладёт этот кусок в modulepreload
 * на /s/:id. Оно завязано на имя файла, поэтому переименование экрана обязано
 * доехать и сюда — за этим следит проверка в самом `firstPaint`, которая роняет
 * сборку, а не молчит.
 */
const ROOM_CHUNK = 'SessionScreen'
/*
 * И два куска, которые комната просит динамически, но просит ВСЕГДА: редактор
 * ячейки и рендерер вывода. Статическим графом (`reach` в firstPaint) их не
 * достать — тем графом и считается всё остальное, чтобы список не отставал от
 * сборки, — а греть их вместе с экраном надо, иначе тетрадь рисуется в две
 * волны сети вместо одной.
 */
const ROOM_ALSO = ['codemirror', 'render'] as const

function manualChunks(id: string): string | undefined {
  // The editor's palette is never wanted without the editor, and a second
  // request for 5 KB costs more than the bytes do.
  if (id.endsWith('/components/notebook/cm-theme.ts')) return 'codemirror'
  const pkg = packageOf(id)
  if (!pkg) return undefined
  if (CODEMIRROR.test(pkg)) return 'codemirror'
  if (YJS.test(pkg)) return 'yjs'
  if (RENDER.test(pkg)) return 'render'
  if (PDF.test(pkg)) return 'pdf'
  return undefined
}

/* ------------------------------------------------------- first-paint plugin */

/**
 * Комментарии — в исходник, а не в ответ браузеру.
 *
 * Vite не минифицирует HTML, и собранный index.html уезжал с десятью
 * килобайтами объяснений: и своих `<!-- -->`, и блочных внутри встроенного
 * `<style>`. Это 8.9 КБ brotli против 3.0 без них — на КАЖДУЮ навигацию, то
 * есть на каждый вход в комнату, впереди всего остального.
 *
 * Исходник при этом остаётся как есть: объяснения в index.html написаны для
 * того, кто будет его править, а не для того, кто открывает ссылку на семинар.
 * Скрипты не трогаются вовсе — там блочный комментарий это код, а не оформление.
 */
const SCRIPTS = /<script\b[^>]*>[\s\S]*?<\/script>/gi
const STYLES = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi
function withoutComments(html: string): string {
  const kept: string[] = []
  const masked = html.replace(SCRIPTS, (tag) => '\u0000' + (kept.push(tag) - 1) + '\u0000')
  const stripped = masked
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(STYLES, (_all, open: string, css: string, close: string) =>
      open + css.replace(/\/\*[\s\S]*?\*\//g, '') + close)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
  return stripped.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => kept[Number(index)]!)
}

/*
 * Одна и та же пара помощников для обоих скриптов в голове: `add` кладёт ссылку
 * предзагрузки, разбираясь, модуль это или стиль, а `lang` читает язык из
 * `<html lang>`, который сервер уже переписал под инстанс (frontend-html.ts).
 * Мета с языком лежит ПОСЛЕ этих скриптов и им ещё не видна.
 */
const PRELOAD_HELPERS =
  `const add=(f,w)=>{const l=document.createElement("link");const css=f.endsWith(".css");` +
  `l.rel=css?"preload":"modulepreload";if(css)l.as="style";l.crossOrigin="anonymous";` +
  `if(w)l.fetchPriority=w;l.href=f;document.head.appendChild(l)};` +
  `const lang=document.documentElement.lang==="en"?"en":"ru";`

/**
 * Правки к HTML, который отдаёт Vite, — все ради первого кадра:
 *
 *  - комментарии уходят (см. выше);
 *  - таблица стилей перестаёт блокировать отрисовку, но едет с ВЫСОКИМ
 *    приоритетом: `rel=preload as=style` вместо `media=print`, который в Chrome
 *    получал Low и приезжал позже шрифтов. main.ts держит оболочку до тех пор,
 *    пока лист не применился, так что раздетым приложение не видно;
 *  - код формы просится первым в документе, раньше кусков комнаты, и вместе со
 *    своим CSS, которого помощник предзагрузки Vite всё равно дождётся;
 *  - куски комнаты греются с fetchpriority=low: они нужны после формы, а не
 *    вместо неё. Их состав считается по сборке, а не перечисляется руками.
 */
function firstPaint(): Plugin {
  let base = '/'
  return {
    name: 'colloq-first-paint',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        let out = withoutComments(html)
        // The cold form's small date/id labels can use the metric-matched
        // fallback until normal font discovery. Do not put 31 KB of code font
        // ahead of its JS. Returning rooms still preload before editors paint.
        //
        // `/` и `/admin` — это форма входа штата, и кода на ней нет вовсе:
        // моноширинный там грелся просто потому, что «не комната».
        out = out.replace(/<link\b[^>]*href="\/fonts\/jetbrains-mono-latin\.woff2"[^>]*>/g,
          `<script data-colloq-mono-preload>(()=>{const p=location.pathname;` +
          `const room=/^\\/s\\/([A-Za-z0-9_-]{1,64})(?:\\/|$)/.exec(p);` +
          `let warm=/^\\/(?:c|p)\\//.test(p);` +
          `try{if(room)warm=!!JSON.parse(localStorage.getItem("colloq.identity.v1")||"{}")[room[1]]?.token}catch{}` +
          `if(warm){const l=document.createElement("link");l.rel="preload";l.as="font";l.type="font/woff2";` +
          `l.crossOrigin="anonymous";l.href="/fonts/jetbrains-mono-latin.woff2";document.head.appendChild(l)}})()</script>`)
        out = out.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, (tag) => {
          // Leave anything already deferred alone, and anything cross-origin:
          // the fonts are ours and local now, but the rule outlives them.
          if (/\bmedia=/.test(tag) || /href="https?:/.test(tag)) return tag
          const deferred = tag
            .replace(/\brel="stylesheet"/, 'rel="preload" as="style"')
            .replace(/\/?>$/, ` onload="this.rel='stylesheet'" data-colloq-css>`)
          return `${deferred}<noscript>${tag}</noscript>`
        })

        type Chunk = {
          fileName: string
          name?: string
          imports?: string[]
          viteMetadata?: { importedCss?: Iterable<string> }
        }
        const chunks = Object.values(ctx.bundle ?? {})
          .filter((asset): asset is typeof asset & Chunk => asset.type === 'chunk')
        const byName = new Map(chunks.map((chunk) => [chunk.name, chunk]))
        const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
        /*
         * И вслух, если имя разошлось со сборкой.
         *
         * Имена кусков — это строки, а модули переименовывают: молча выпавший
         * отсюда `SessionScreen` не сломал бы ничего заметного, просто вернул бы
         * тот самый лишний круг сети, который здесь и убирают. Такое не
         * замечают годами, поэтому сборка падает.
         */
        const need = (name: string): Chunk => {
          const chunk = byName.get(name)
          if (!chunk) {
            throw new Error(
              `colloq-first-paint: в сборке нет куска ${name} — его переименовали, ` +
                'а предзагрузка в голове осталась со старым именем',
            )
          }
          return chunk
        }
        /** Кусок и всё, что он тянет статически: это и есть одна волна сети. */
        const reach = (start: Chunk[]): Chunk[] => {
          const seen = new Map<string, Chunk>()
          const pending = [...start]
          while (pending.length > 0) {
            const chunk = pending.shift()!
            if (seen.has(chunk.fileName)) continue
            seen.set(chunk.fileName, chunk)
            for (const file of chunk.imports ?? []) {
              const next = byFile.get(file)
              if (next) pending.push(next)
            }
          }
          return [...seen.values()]
        }
        /** Листы стилей этих кусков, кроме тех, что страница уже называет. */
        const styles = (list: Chunk[]): string[] => [
          ...new Set(list.flatMap((chunk) => [...(chunk.viteMetadata?.importedCss ?? [])])),
        ].filter((file) => !out.includes(`href="${base}${file}"`))
        /** Словарь области на каждом языке: выбор делает скрипт в голове. */
        const speaks = (area: string, files: string[]): Record<string, string[]> =>
          Object.fromEntries(LOCALES.map((locale) =>
            [locale, [...files, base + need(`${area}-${locale}`).fileName]]))

        /*
         * Вход — ПЕРВЫМ в документе. Раньше скрипт комнаты стоял выше этих
         * ссылок, и 394 КБ тетради успевали занять очередь перед App.js: форма
         * имени ждала кода, который ей не нужен.
         *
         * Вместе с ним — его собственный CSS. Помощник предзагрузки Vite ждёт
         * `App-*.css` перед тем, как выполнить App, а в голове его не было: о
         * нём узнавали из index.js, то есть волной позже, и 852 байта стояли
         * между входным куском и экраном.
         */
        const entry = reach([need('App')])
        out = out.replace('</head>', [
          ...entry.map((chunk) => `<link rel="modulepreload" crossorigin href="${base}${chunk.fileName}">`),
          ...styles(entry).map((file) =>
            `<link rel="preload" as="style" href="${base}${file}" onload="this.rel='stylesheet'">`),
        ].join('') + '</head>')

        /*
         * Комната. Состав считается по сборке: экран и всё, что он тянет
         * статически, — перечисленные руками четыре имени отставали на волну,
         * потому что SessionScreen статически тянет ещё yjs, CellOutputs,
         * буфер обмена, хранилище и ссылку на семинар. Редактор и рендерер он
         * просит динамически, но просит всегда, поэтому названы отдельно.
         *
         * Only returning identities need these before the form. Cold visitors
         * warm them after paint, while typing, instead of waiting for /join
         * and then document sync to start the editor's download.
         */
        const entryFiles = new Set(entry.map((chunk) => chunk.fileName))
        const room = reach([need(ROOM_CHUNK), ...ROOM_ALSO.map(need)])
        const roomFiles = [
          ...room.filter((chunk) => !entryFiles.has(chunk.fileName)).map((chunk) => base + chunk.fileName),
          ...styles(room).map((file) => base + file),
        ]
        out = out.replace('</head>',
          `<script data-colloq-room-preload>(()=>{const room=/^\\/s\\/([A-Za-z0-9_-]{1,64})(?:\\/|$)/.exec(location.pathname);` +
            `let known=false;try{known=!!(room&&JSON.parse(localStorage.getItem("colloq.identity.v1")||"{}")[room[1]]?.token)}catch{}` +
            `${PRELOAD_HELPERS}const files=${JSON.stringify(speaks('room', roomFiles))};` +
            `let warmed=false;const warm=()=>{if(!room||warmed)return;warmed=true;` +
            `for(const f of files[lang])add(f,"low")};` +
            `if(known)warm();else window.addEventListener("colloq:ready",warm,{once:true})})()</script></head>`)

        // These routes have no join form. Fetch their code and catalog together
        // now, while loadLocalizedScreen still controls evaluation order.
        const route = (area: string, names: string[]) => speaks(area, names.flatMap((name) => {
          const chunk = byName.get(name)
          return chunk ? [base + chunk.fileName, ...styles([chunk]).map((file) => base + file)] : []
        }))
        out = out.replace('</head>', `<script data-colloq-route-preload>(()=>{` +
          `const p=location.pathname;${PRELOAD_HELPERS}` +
          `const files=/^\\/(?:admin(?:\\/|$)|$)/.test(p)?${JSON.stringify(route('admin', ['AdminScreen']))}:` +
          `/^\\/(?:c|p)\\//.test(p)?${JSON.stringify(route('reader', ['ReaderScreen', 'render']))}:null;` +
          `if(files)for(const f of files[lang])add(f)})()</script></head>`)
        return out
      },
    },
  }
}

export default defineConfig({
  plugins: [entryLanguage(), screenLanguage(), svelte(), firstPaint()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // shared/ lives outside web/, so without dedupe it could pull a second
    // copy of Yjs — which quietly breaks every instanceof check in the CRDT.
    dedupe: ['yjs', 'y-protocols'],
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/collab': { target: API_TARGET, ws: true },
      '/control': { target: API_TARGET, ws: true },
      // Документ открытого файла — четвёртый сокет сервера, и забыть его здесь
      // значит редактор, который на стенде «подключается» до конца дня.
      '/file': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { manualChunks } },
  },
})
