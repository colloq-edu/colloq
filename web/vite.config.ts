import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import { messages } from '../shared/i18n'
import { collectEntryMessages } from './scripts/entry-messages'

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000'

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
 * Two edits to the HTML Vite emits, both aimed at the first frame:
 *
 *  - the app stylesheet stops blocking render, so the inlined shell in
 *    index.html paints with zero network. main.ts holds the shell up until the
 *    sheet has applied, so the app itself is never seen undressed.
 *  - the router/join form is requested alongside the entry, so a cold visit
 *    doesn't wait for entry → language API → form before starting its download.
 *    The notebook is warmed immediately for a saved identity, and after the
 *    form paints for a cold visit, without delaying the name field.
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
        // The cold form's small date/id labels can use the metric-matched
        // fallback until normal font discovery. Do not put 31 KB of code font
        // ahead of its JS. Returning rooms still preload before editors paint.
        let out = html.replace(/<link\b[^>]*href="\/fonts\/jetbrains-mono-latin\.woff2"[^>]*>/g,
          `<script data-colloq-mono-preload>(()=>{const room=/^\\/s\\/([A-Za-z0-9_-]{1,64})(?:\\/|$)/.exec(location.pathname);` +
          `let warm=!room;try{if(room)warm=!!JSON.parse(localStorage.getItem("colloq.identity.v1")||"{}")[room[1]]?.token}catch{}` +
          `if(warm){const l=document.createElement("link");l.rel="preload";l.as="font";l.type="font/woff2";` +
          `l.crossOrigin="anonymous";l.href="/fonts/jetbrains-mono-latin.woff2";document.head.appendChild(l)}})()</script>`)
        out = out.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, (tag) => {
          // Leave anything already deferred alone, and anything cross-origin:
          // the fonts are ours and local now, but the rule outlives them.
          if (/\bmedia=/.test(tag) || /href="https?:/.test(tag)) return tag
          const deferred = tag.replace(
            /\/?>$/,
            ` media="print" onload="this.media='all'" data-colloq-css>`,
          )
          return `${deferred}<noscript>${tag}</noscript>`
        })

        // Only returning identities need these before the form. Cold visitors
        // warm them after paint, while typing, instead of waiting for /join
        // and then document sync to start the editor's download.
        const notebookOnly = new Set([ROOM_CHUNK, 'codemirror', 'render', 'full-language'])
        const deferred = Object.values(ctx.bundle ?? {}).filter(
          (asset): asset is typeof asset & { fileName: string } =>
            asset.type === 'chunk' && notebookOnly.has(asset.name ?? ''),
        )
        /*
         * И вслух, если имя разошлось со сборкой.
         *
         * Имена кусков — это строки, а модули переименовывают: молча выпавший
         * отсюда `SessionScreen` не сломал бы ничего заметного, просто вернул бы
         * тот самый лишний круг сети, который здесь и убирают. Такое не
         * замечают годами, поэтому сборка падает.
         */
        const found = new Set(deferred.map((chunk) => chunk.name))
        const missing = [...notebookOnly].filter((name) => !found.has(name))
        if (missing.length > 0) {
          throw new Error(
            `colloq-first-paint: в сборке нет кусков ${missing.join(', ')} — ` +
              'их переименовали, а modulepreload на /s/:id остался со старым именем',
          )
        }
        if (deferred.length > 0) {
          const files = JSON.stringify(deferred.map((chunk) => base + chunk.fileName))
          out = out.replace(
            '</head>',
            `<script data-colloq-room-preload>(()=>{const room=/^\\/s\\/([A-Za-z0-9_-]{1,64})(?:\\/|$)/.exec(location.pathname);` +
              `let known=false;try{known=!!(room&&JSON.parse(localStorage.getItem("colloq.identity.v1")||"{}")[room[1]]?.token)}catch{}` +
              `let warmed=false;const warm=()=>{if(!room||warmed)return;warmed=true;for(const f of ${files}){` +
              `const l=document.createElement("link");l.rel="modulepreload";` +
              `l.crossOrigin="anonymous";l.href=f;document.head.appendChild(l)}};` +
              `if(known)warm();else window.addEventListener("colloq:ready",warm,{once:true})})()</script></head>`,
          )
        }
        const entry = Object.values(ctx.bundle ?? {}).find(
          (asset) => asset.type === 'chunk' && asset.name === 'App',
        )
        if (!entry || entry.type !== 'chunk') throw new Error('Missing App chunk for first-paint preload')
        const formFiles = new Set([entry.fileName, ...entry.imports])
        out = out.replace('</head>', [...formFiles].map((file) =>
          `<link rel="modulepreload" crossorigin href="${base}${file}">`,
        ).join('') + '</head>')
        // These routes have no join form. Fetch their code and catalog together
        // now, while loadLocalizedScreen still controls evaluation order.
        const routeFiles = (names: string[]) => names.flatMap((name) => {
          const chunk = Object.values(ctx.bundle ?? {}).find((asset) => asset.type === 'chunk' && asset.name === name)
          return chunk ? [base + chunk.fileName] : []
        })
        const adminFiles = JSON.stringify(routeFiles(['full-language', 'AdminScreen']))
        const readerFiles = JSON.stringify(routeFiles(['full-language', 'ReaderScreen', 'render']))
        out = out.replace('</head>', `<script data-colloq-route-preload>(()=>{` +
          `const p=location.pathname;const files=/^\\/(?:admin(?:\\/|$)|$)/.test(p)?${adminFiles}:` +
          `/^\\/(?:c|p)\\//.test(p)?${readerFiles}:[];for(const f of files){` +
          `const l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="anonymous";` +
          `l.href=f;document.head.appendChild(l)}})()</script></head>`)
        return out
      },
    },
  }
}

export default defineConfig({
  plugins: [entryLanguage(), svelte(), firstPaint()],
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
