import { readdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

/** Compress immutable application assets and the separately copied PDF worker. */
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
  const worker = path.join(root, 'pdf/pdf.worker.min.mjs')
  try { if ((await stat(worker)).isFile()) files.push(worker) } catch (error) {
    if (error.code !== 'ENOENT') throw error
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
