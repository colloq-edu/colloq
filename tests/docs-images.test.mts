/**
 * Картинки в исходниках документации: файл есть, размеры в разметке — его
 * настоящие, и каждый язык показывает свой интерфейс.
 *
 * Английская главная до 18.09.2026 показывала русский снимок комнаты с
 * подписью «shown here with the Russian interface»: страницу перевели, а
 * картинку взяли из русской, потому что другой не было. Английский снимок
 * теперь есть (site/img/workspace-en@1x.webp), и третий тест держит правило
 * целиком: если у картинки есть `-en`-двойник, английская страница берёт его,
 * а русская — никогда не берёт чужой.
 *
 * width/height сверяются с файлом, а не на глаз: браузер резервирует место по
 * атрибутам, и снимок, переснятый в другом размере при старой разметке,
 * растягивается в чужие пропорции — на лендинге так уже было (коммит 0e03dc9,
 * «обновить снимок без искажения пропорций»).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PAGES = join(ROOT, 'docs', 'pages')
const SITE = join(ROOT, 'site')
const LANGS = ['ru', 'en'] as const

interface Img {
  page: string
  lang: (typeof LANGS)[number]
  src: string
  /** Кандидаты srcset: браузер вправе взять любой, и русский 2x в нём — тот же чужой снимок. */
  srcset: string[]
  width: number | null
  height: number | null
}

function images(): Img[] {
  const out: Img[] = []
  for (const lang of LANGS) {
    const dir = join(PAGES, lang)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
      const html = readFileSync(join(dir, name), 'utf8')
      for (const [tag] of html.matchAll(/<img\b[^>]*>/g)) {
        const attr = (key: string) => tag.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1] ?? null
        const src = attr('src')
        if (!src) continue
        const num = (key: string) => (attr(key) === null ? null : Number(attr(key)))
        const srcset = (attr('srcset') ?? '').split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean)
        out.push({ page: `${lang}/${name}`, lang, src, srcset, width: num('width'), height: num('height') })
      }
    }
  }
  return out
}

/** Размер webp (VP8, VP8L, VP8X) или png по заголовку — без зависимостей. */
function dimensions(file: string): { width: number; height: number } {
  const b = readFileSync(file)
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
    throw new Error(`${file}: unknown WebP chunk ${chunk}`)
  }
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  throw new Error(`${file}: neither WebP nor PNG`)
}

/**
 * `/img/x.webp?v=757a8c51` → `/img/x.webp`. Хвост ?v= — обычай этого сайта
 * (лендинг так сбрасывает кэш), и без отрезания регулярки ниже, привязанные к
 * концу строки, его не видят: «двойник» `/img/og.png?v=…` выходил им же самим,
 * и английская страница падала с «английская версия существует».
 */
function bare(src: string): string {
  return src.split(/[?#]/)[0]
}

/** Путь сайта (`/img/x.webp`) → файл в site/, только для своих картинок. */
function local(src: string): string | null {
  return src.startsWith('/') && !src.startsWith('//') ? join(SITE, bare(src)) : null
}

/** `/img/workspace@1x.webp` → `/img/workspace-en@1x.webp`: суффикс плотности остаётся в конце. */
function englishTwin(src: string): string {
  return bare(src).replace(/(@\d+(?:\.\d+)?x)?(\.[a-z0-9]+)$/i, '-en$1$2')
}

const ENGLISH = /-en(@[\d.]+x)?\.[a-z0-9]+$/i

test('every image a docs page shows exists and is declared at its real size', () => {
  const found = images()
  assert.ok(found.length > 0, 'docs pages show no images at all: the regex or the paths moved')
  for (const img of found) {
    for (const candidate of img.srcset) {
      const file = local(candidate)
      if (file) assert.ok(existsSync(file), `${img.page}: srcset ${candidate} is not in site/`)
    }
    const file = local(img.src)
    if (!file) continue
    assert.ok(existsSync(file), `${img.page}: ${img.src} is not in site/`)
    assert.ok(img.width && img.height, `${img.page}: ${img.src} needs width and height, or the page jumps as it loads`)
    const real = dimensions(file)
    assert.deepEqual(
      { width: img.width, height: img.height },
      real,
      `${img.page}: ${img.src} is declared ${img.width}×${img.height} but the file is ${real.width}×${real.height}`,
    )
  }
})

test('the English docs index shows the English workspace, without the "Russian interface" caveat', () => {
  const html = readFileSync(join(PAGES, 'en', 'index.html'), 'utf8')
  assert.match(html, /src="\/img\/workspace-en@1x\.webp(?:[?#][^"]*)?"/)
  assert.doesNotMatch(html, /Russian interface/i)
  const shot = dimensions(join(SITE, 'img', 'workspace-en@1x.webp'))
  assert.deepEqual(shot, dimensions(join(SITE, 'img', 'workspace@1x.webp')), 'the two workspace shots are cut to the same frame')
})

test('a page uses the screenshot in its own language whenever one exists', () => {
  for (const img of images()) {
    for (const src of [img.src, ...img.srcset]) {
      if (!local(src)) continue
      if (img.lang === 'ru') {
        assert.doesNotMatch(bare(src), ENGLISH, `${img.page}: a Russian page shows the English ${src}`)
        continue
      }
      if (ENGLISH.test(bare(src))) continue
      const twin = englishTwin(src)
      assert.ok(!existsSync(local(twin)!), `${img.page}: shows ${src}, but the English ${twin} exists`)
    }
  }
})
