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
import { competitionsMessages } from '../shared/locales/competitions'
import { collectEntryMessages, collectClientKeys } from './scripts/entry-messages'

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000'
/*
 * The version comes from the root package.json, its only source (see
 * scripts/version.mts). The panel draws it next to the logo; there used to be
 * a hard-coded string "v0.1" there, which would not have changed with any
 * release.
 */
const COLLOQ_VERSION = (JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }).version
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
 * A screen's dictionary: one area, one language.
 *
 * There used to be one for everybody — `full-language`, 351 KB of source and
 * 74 KB over the wire, and it arrived BEFORE any screen. It held both
 * languages, the whole teacher panel catalog and the whole server one, of
 * which the browser can look up about thirty keys. A room in one language
 * needs 80 KB.
 *
 * The real files lib/messages/<area>-<language>.ts stay on disk: node and
 * the tests load them, and they are the only place where an area's
 * COMPOSITION is written down. Here their content is replaced with the
 * build-time one: the same catalogs, read from their own imports, but one
 * language and a trimmed `server`.
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
    competitions: competitionsMessages,
  }
  /*
   * The server catalog is the only one cut by keys rather than taken whole.
   *
   * Almost all of it never reaches the browser: it is publication pages,
   * emails and the log. The client translates the server's state WORDS
   * ("kernel busy") and a few default names, and all of them are written
   * literally in its sources — that is where they are counted from. Errors
   * arrive already translated by the server and pass through tr() untouched;
   * they need no dictionary.
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
        throw new Error(`colloq-screen-language: ${file} — the name must be <area>-<ru|en>.ts`)
      }
      const source = fs.readFileSync(file, 'utf8')
      const wanted = [...source.matchAll(/@shared\/locales\/([a-z]+)/g)].map((match) => match[1])
      if (wanted.length === 0) throw new Error(`colloq-screen-language: ${file} has no catalogs`)
      client ??= collectClientKeys(root, messages, 'server')
      const out: Record<string, Record<string, unknown>> = {}
      for (const name of wanted) {
        const catalog = catalogs[name]
        if (!catalog) throw new Error(`colloq-screen-language: unknown catalog ${name}`)
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
/* pdf.js arrives only when a document is opened in the room; its worker goes
   around the bundler, as a separate file from public/ — see lib/pdf.svelte.ts. */
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
 * The name of the room chunk — the one Rollup calls it by: the module's base
 * name.
 *
 * SessionScreen does not ask for a chunk of its own and must not: it ends up
 * in a separate one anyway, because it is loaded with a dynamic `import()`.
 * Asking for it through `manualChunks` was tried — and it is WORSE: a
 * manually assigned chunk drags along what the entry needs too, and the built
 * index.js gets a STATIC import from it. That is, the room's 457 KB start
 * downloading on the join screen — exactly what the screens were split for.
 *
 * The name is needed here for one thing: `firstPaint` below puts this chunk
 * into modulepreload on /s/:id. It is tied to the file name, so renaming the
 * screen must reach here too — a check in `firstPaint` itself watches for
 * that, and it fails the build instead of keeping quiet.
 */
const ROOM_CHUNK = 'SessionScreen'
/*
 * And two chunks the room asks for dynamically, but ALWAYS asks for: the cell
 * editor and the output renderer. The static graph (`reach` in firstPaint)
 * cannot reach them — that graph is what everything else is computed from, so
 * the list does not lag behind the build — yet they have to be warmed along
 * with the screen, otherwise the notebook paints in two network waves instead
 * of one.
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
 * Comments belong in the source, not in the answer to the browser.
 *
 * Vite does not minify HTML, and the built index.html went out with ten
 * kilobytes of explanations: its own `<!-- -->` ones and the block ones inside
 * the inline `<style>`. That is 8.9 KB of brotli versus 3.0 without them — on
 * EVERY navigation, that is, on every entry into a room, ahead of everything
 * else.
 *
 * The source stays as it is: the explanations in index.html are written for
 * whoever will edit it, not for whoever opens a seminar link. Scripts are not
 * touched at all — there a block comment is code, not decoration.
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
 * The same pair of helpers for both scripts in the head: `add` inserts a
 * preload link, working out whether it is a module or a stylesheet, and
 * `lang` reads the language from `<html lang>`, which the server has already
 * rewritten for the instance (frontend-html.ts). The language meta comes
 * AFTER these scripts and is not visible to them yet.
 */
const PRELOAD_HELPERS =
  `const add=(f,w)=>{const l=document.createElement("link");const css=f.endsWith(".css");` +
  `l.rel=css?"preload":"modulepreload";if(css)l.as="style";l.crossOrigin="anonymous";` +
  `if(w)l.fetchPriority=w;l.href=f;document.head.appendChild(l)};` +
  `const lang=document.documentElement.lang==="en"?"en":"ru";`

/**
 * Edits to the HTML Vite serves — all for the sake of the first frame:
 *
 *  - comments go away (see above);
 *  - the stylesheet stops blocking rendering but travels at HIGH priority:
 *    `rel=preload as=style` instead of `media=print`, which in Chrome got Low
 *    and arrived after the fonts. main.ts keeps the shell up until the sheet
 *    has applied, so the app is never seen undressed;
 *  - the form's code is requested first in the document, before the room
 *    chunks, together with its CSS, which Vite's preload helper waits for
 *    anyway;
 *  - the room chunks are warmed with fetchpriority=low: they are needed after
 *    the form, not instead of it. Their composition is computed from the
 *    build, not listed by hand.
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
        // `/` and `/admin` are the staff sign-in form, and there is no code on
        // it at all: the monospace font was warmed there just because "it is
        // not the room".
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
         * And out loud, if a name has drifted from the build.
         *
         * Chunk names are strings, and modules get renamed: a `SessionScreen`
         * silently dropped from here would break nothing noticeable, it would
         * just bring back the very extra network round trip that is removed
         * here. Such things go unnoticed for years, so the build fails.
         */
        const need = (name: string): Chunk => {
          const chunk = byName.get(name)
          if (!chunk) {
            throw new Error(
              `colloq-first-paint: the build has no chunk ${name} — it was renamed, ` +
                'but the preload in the head kept the old name',
            )
          }
          return chunk
        }
        /** A chunk and everything it pulls in statically: that is one network wave. */
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
        /** The stylesheets of these chunks, except those the page already names. */
        const styles = (list: Chunk[]): string[] => [
          ...new Set(list.flatMap((chunk) => [...(chunk.viteMetadata?.importedCss ?? [])])),
        ].filter((file) => !out.includes(`href="${base}${file}"`))
        /** The area's dictionary in each language: the script in the head picks one. */
        const speaks = (area: string, files: string[]): Record<string, string[]> =>
          Object.fromEntries(LOCALES.map((locale) =>
            [locale, [...files, base + need(`${area}-${locale}`).fileName]]))

        /*
         * The entry goes FIRST in the document. The room script used to stand
         * above these links, and the notebook's 394 KB managed to take the
         * queue before App.js: the name form waited for code it does not need.
         *
         * Together with it — its own CSS. Vite's preload helper waits for
         * `App-*.css` before running App, and it was not in the head: it was
         * discovered from index.js, that is, one wave later, and 852 bytes
         * stood between the entry chunk and the screen.
         */
        const entry = reach([need('App')])
        out = out.replace('</head>', [
          ...entry.map((chunk) => `<link rel="modulepreload" crossorigin href="${base}${chunk.fileName}">`),
          ...styles(entry).map((file) =>
            `<link rel="preload" as="style" href="${base}${file}" onload="this.rel='stylesheet'">`),
        ].join('') + '</head>')

        /*
         * The room. Its composition is computed from the build: the screen and
         * everything it pulls in statically — the four names listed by hand
         * lagged a wave behind, because SessionScreen also statically pulls in
         * yjs, CellOutputs, the clipboard, storage and the seminar link. The
         * editor and the renderer it asks for dynamically, but always, so they
         * are named separately.
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
  define: { __COLLOQ_VERSION__: JSON.stringify(COLLOQ_VERSION) },
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
      // The open file's document is the server's fourth socket, and forgetting
      // it here means an editor that "connects" on the test bench all day long.
      '/file': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { manualChunks } },
  },
})
