import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath, URL } from 'node:url'

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000'

/* ------------------------------------------------------------------ chunks */

/*
 * One chunk per heavy vendor. Two payoffs: a student who opens the join screen
 * never downloads the editor, the markdown renderer or the ANSI parser, and a
 * student who comes back next week revalidates only the chunks that actually
 * changed instead of one monolith whose hash moves on every app edit.
 */
const CODEMIRROR = /^(@codemirror\/|@lezer\/|y-codemirror\.next$|style-mod$|w3c-keyname$|crelt$)/
const YJS = /^(yjs|y-websocket|y-protocols|y-indexeddb|lib0)$/
/* marked, DOMPurify and ansi_up are loaded together by lib/render.svelte.ts and
   are useless apart, so they ship as one chunk rather than three requests. */
const RENDER = /^(marked|dompurify|ansi_up)$/

const NODE_MODULES = 'node_modules/'

/** The npm package a module id belongs to, scope included. */
function packageOf(id: string): string | null {
  const at = id.lastIndexOf(NODE_MODULES)
  if (at === -1) return null
  const [first = '', second = ''] = id.slice(at + NODE_MODULES.length).split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

function manualChunks(id: string): string | undefined {
  // The editor's palette is never wanted without the editor, and a second
  // request for 5 KB costs more than the bytes do.
  if (id.endsWith('/components/notebook/cm-theme.ts')) return 'codemirror'
  const pkg = packageOf(id)
  if (!pkg) return undefined
  if (CODEMIRROR.test(pkg)) return 'codemirror'
  if (YJS.test(pkg)) return 'yjs'
  if (RENDER.test(pkg)) return 'render'
  return undefined
}

/* ------------------------------------------------------- first-paint plugin */

/**
 * Two edits to the HTML Vite emits, both aimed at the first frame:
 *
 *  - the app stylesheet stops blocking render, so the inlined shell in
 *    index.html paints with zero network. main.ts holds the shell up until the
 *    sheet has applied, so the app itself is never seen undressed.
 *  - a seminar link goes straight into the notebook, so on /s/:id the editor
 *    and renderer chunks are requested alongside the entry rather than three
 *    round trips later, once the route has resolved and the first cell has
 *    mounted. On '/' neither is fetched at all — that is the whole point of
 *    splitting them out.
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
          // Leave anything cross-origin (fonts) and anything already deferred alone.
          if (/\bmedia=/.test(tag) || /href="https?:/.test(tag)) return tag
          const deferred = tag.replace(
            /\/?>$/,
            ` media="print" onload="this.media='all'" data-colloq-css>`,
          )
          return `${deferred}<noscript>${tag}</noscript>`
        })

        const notebookOnly = new Set(['codemirror', 'render'])
        const deferred = Object.values(ctx.bundle ?? {}).filter(
          (asset): asset is typeof asset & { fileName: string } =>
            asset.type === 'chunk' && notebookOnly.has(asset.name ?? ''),
        )
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
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { manualChunks } },
  },
})
