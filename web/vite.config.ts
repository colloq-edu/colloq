import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath, URL } from 'node:url'

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000'

/* ------------------------------------------------------------------ chunks */

/*
 * One chunk per heavy vendor. Two payoffs: a student who opens '/' never
 * downloads the editor, the markdown renderer or the ANSI parser, and a
 * student who comes back next week revalidates only the chunks that actually
 * changed instead of one monolith whose hash moves on every app edit.
 *
 * Экран входа живёт на /s/:id, и там codemirror с render нарочно приезжают
 * сразу: за входом всегда идёт комната — см. firstPaint ниже.
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
 *  - a seminar link goes straight into the notebook, so on /s/:id the room
 *    screen and the editor and renderer chunks are requested alongside the
 *    entry rather than three round trips later, once the route has resolved and
 *    the first cell has mounted. On '/' none of them is fetched at all — that is
 *    the whole point of splitting them out.
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
        let out = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, (tag) => {
          // Leave anything already deferred alone, and anything cross-origin:
          // the fonts are ours and local now, but the rule outlives them.
          if (/\bmedia=/.test(tag) || /href="https?:/.test(tag)) return tag
          const deferred = tag.replace(
            /\/?>$/,
            ` media="print" onload="this.media='all'" data-colloq-css>`,
          )
          return `${deferred}<noscript>${tag}</noscript>`
        })

        /*
         * Что просить сразу на /s/:id: сам экран комнаты и то, без чего он не
         * рисует ни одной ячейки. Все три — уже собранные куски, так что это не
         * лишние байты, а те же самые, запрошенные на круг раньше. Экран
         * комнаты — самый крупный из них, и до сих пор он начинал качаться
         * только после того, как index.js скачан, разобран и запущен: лишний
         * круг сети на единственном пути, по которому в комнату идут все.
         */
        const notebookOnly = new Set([ROOM_CHUNK, 'codemirror', 'render'])
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
            `<script>if(location.pathname.startsWith("/s/"))for(const f of ${files}){` +
              `const l=document.createElement("link");l.rel="modulepreload";` +
              `l.crossOrigin="anonymous";l.href=f;document.head.appendChild(l)}</script></head>`,
          )
        }
        return out
      },
    },
  }
}

export default defineConfig({
  plugins: [svelte(), firstPaint()],
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
