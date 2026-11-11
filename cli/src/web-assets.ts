import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

/** The dev supervisor calls Vite directly, so it must prepare the same public
 * assets as `npm run assets`. Plotly is a strict module build, not a copy of
 * the old monolithic distribution. A build failure is visible but does not
 * take down unrelated development features. */
export function layOutWebAssets(root: string): void {
  try {
    const from = createRequire(path.join(root, 'web/package.json'))
    const source = from.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
    const target = path.join(root, 'web/public/pdf/pdf.worker.min.mjs')
    if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
  } catch (error) {
    console.warn(`[colloq] PDF worker: ${error instanceof Error ? error.message : String(error)} — npm ci?`)
  }
  const result = spawnSync(process.execPath, [path.join(root, 'web/scripts/plotly.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
  })
  if (result.error || result.status !== 0) {
    console.warn(`[colloq] Plotly modules: ${result.error?.message ?? result.stderr.trim()} — npm ci?`)
  }
}
