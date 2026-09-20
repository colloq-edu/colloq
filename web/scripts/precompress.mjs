import { readdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

/**
 * Compress immutable application assets and the two bundles copied in beside
 * them: the PDF worker and plotly.js.
 *
 * Пять мегабайт plotly сжимаются до 1.1 МБ brotli, и разница видна не в
 * графике на экране, а в аудитории на общем вайфае: без этого шага первый
 * график занятия качается вчетверо дольше. Сжимается он здесь, а не сборщиком,
 * по той же причине, что и воркер pdf.js, — оба приезжают в `public/` мимо
 * Rollup, файлами, которые положил туда скрипт.
 */
export async function precompress(directory) {
  const root = path.resolve(directory)
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && /\.(?:m?js|css|svg|json)$/.test(entry.name)) files.push(file)
    }
  }
  await walk(path.join(root, 'assets'))
  for (const copied of ['pdf/pdf.worker.min.mjs', 'plotly/plotly.min.js']) {
    const file = path.join(root, copied)
    try { if ((await stat(file)).isFile()) files.push(file) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const totals = { files: 0, original: 0, brotli: 0, gzip: 0 }
  for (const file of files.sort()) {
    const source = await readFile(file)
    const encoded = source.length >= 1024 ? [
      ['br', 'brotli', brotliCompressSync(source, { params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      } })],
      ['gz', 'gzip', gzipSync(source, { level: 9 })],
    ] : []
    let saved = false
    for (const extension of ['br', 'gz']) {
      const result = encoded.find(([suffix]) => suffix === extension)
      if (result && result[2].length < source.length) {
        await writeFile(`${file}.${extension}`, result[2])
        totals[result[1]] += result[2].length
        saved = true
      } else {
        await rm(`${file}.${extension}`, { force: true })
      }
    }
    if (saved) { totals.files++; totals.original += source.length }
  }
  return totals
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const start = performance.now()
  const totals = await precompress(process.argv[2] ?? 'dist')
  console.log(`Precompressed ${totals.files} files in ${((performance.now() - start) / 1000).toFixed(1)}s: ` +
    `${Math.round(totals.original / 1024)} KiB → ${Math.round(totals.brotli / 1024)} KiB Brotli / ${Math.round(totals.gzip / 1024)} KiB gzip`)
}
