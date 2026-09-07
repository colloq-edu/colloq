/**
 * Шрифт кода: откуда он берётся и почему подмена не двигает строки.
 *
 * Половина этой проверки — та же, что у лендинга (tests/site-fonts): за
 * шрифтами приложение больше никуда не ходит, иначе в университетской сети без
 * выхода наружу тетрадь наберётся системным моноширинным. Вторая половина —
 * про то, чего у лендинга нет: `font-display: swap` меняет шрифт на лету, и
 * пока метрики подменного не приведены к метрикам JetBrains Mono, строки в
 * ячейках и выводах перескакивают под чтение.
 *
 * Проверяется не «красиво», а арифметика и разводка:
 *  — правки метрик сходятся: после size-adjust строка и знак встают ровно туда,
 *    где они у настоящего шрифта;
 *  — подменных семейств два и имена у них разные, потому что перебор ЛИЦ внутри
 *    одной семьи при неподошедшем local() спецификацией не обещан, а перебор
 *    СЕМЕЙСТВ обещан;
 *  — стек живёт в одном месте (--font-mono) и доезжает до всех поверхностей, а
 *    не только до утилиты `font-mono`.
 *
 * Цифры настоящего шрифта измерены fontTools по web/public/fonts/
 * jetbrains-mono-latin.woff2: upm 1000, hhea 1020/-300, lineGap 0, advance 600.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')
/** Объяснение — не обещание: комментарии срезаем, эти адреса названы в них вслух. */
const nocss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const html = nocss(read('web/index.html').replace(/<!--[\s\S]*?-->/g, ''))
const appCss = read('web/src/index.css')
const tailwind = nocss(read('web/tailwind.config.js').replace(/^\s*\/\/.*$/gm, ''))

/** Имена, которые перечисляет `src: local(...)` одного лица. */
const localsOf = (f: Face) =>
  [...(f.get('src') ?? '').matchAll(/local\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1].trim())

/** Каждое @font-face оболочки: имя семейства и его дескрипторы. */
type Face = { family: string; body: string; get(d: string): string | undefined }
const faces: Face[] = [...html.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1]
  const get = (d: string) =>
    new RegExp(`(?:^|;)\\s*${d}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim()
  return { family: (get('font-family') ?? '').replace(/['"]/g, ''), body, get }
})

test('за шрифтами приложение никуда не ходит', () => {
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    assert.ok(
      !html.includes(host),
      `шрифт снова тянется с ${host}: на паре это единственная внешняя ` +
        'зависимость на пути к первому кадру, и в изолированной сети её нет',
    )
  }
  for (const src of html.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
    assert.match(src[1], /^\/fonts\//, `${src[1]} — шрифт не из web/public/fonts`)
    assert.ok(
      existsSync(resolve(ROOT, 'web/public', src[1].slice(1))),
      `${src[1]} объявлен, а файла нет`,
    )
  }
  // JetBrains Mono под SIL OFL 1.1: хостить и резать можно, но текст лицензии
  // обязан лежать рядом с файлами.
  assert.ok(
    existsSync(resolve(ROOT, 'web/public/fonts/JetBrainsMono-OFL.txt')),
    'шрифт положили, а лицензию — нет',
  )
})

test('предзагружается ровно то, чем оболочка набрана', () => {
  const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' '))
  assert.ok(preloads.length > 0, 'не осталось ни одной предзагрузки шрифта')
  for (const tag of preloads) {
    const href = /href="([^"]+)"/.exec(tag)?.[1]
    assert.ok(href, 'предзагрузка без адреса')
    assert.ok(
      existsSync(resolve(ROOT, 'web/public', href!.slice(1))),
      `${href} предзагружается, а файла нет`,
    )
    assert.ok(html.includes(`url('${href}')`), `${href} предзагружается, но ни одним @font-face не набран`)
    assert.match(tag, /crossorigin/, `${href} предзагружается без crossorigin — это второй запрос`)
  }
  // Латиница — на ней набран весь код, она и ждёт у входа; кириллица приезжает
  // по unicode-range, только если такие буквы правда рисуют.
  assert.ok(
    preloads.some((t) => t.includes('/fonts/jetbrains-mono-latin.woff2')),
    'основное подмножество шрифта кода не предзагружается',
  )
})

test('одно имя — одно лицо: у двух правил одной семьи разошлись бы только по unicode-range', () => {
  /*
   * Два @font-face под ОДНИМ именем, оба без unicode-range и с одинаковым
   * начертанием, — это ставка на поведение реализации: спецификация не
   * обещает, что браузер, выбрав лицо и не найдя у него ни одного local(),
   * переберёт остальные лица той же семьи, а не бросит семью целиком. Ровно
   * так подмена и могла бы пропасть на Windows.
   */
  const seen = new Map<string, string>()
  for (const f of faces) {
    const key = [
      f.family.toLowerCase(),
      f.get('font-weight') ?? 'normal',
      f.get('font-style') ?? 'normal',
      f.get('unicode-range') ?? '*',
    ].join(' | ')
    assert.ok(
      !seen.has(key),
      `«${f.family}» объявлено дважды с одинаковыми ключами подбора (${key}) — ` +
        'какое из двух возьмёт браузер и что будет, если у него не найдётся ' +
        'ни одного local(), решает реализация, а не мы',
    )
    seen.set(key, f.body)
  }
})

test('правки метрик приводят подменный шрифт к JetBrains Mono', () => {
  // Настоящий: строка 1.02 + 0.30 = 1.32em, знак 0.6em (см. шапку файла).
  const REAL = { ascent: 1.02, descent: 0.3, advance: 0.6 }
  // Системные, к которым правки применяются: ширина знака в долях em.
  const SYSTEM: Record<string, number> = {
    consolas: 1126 / 2048,
    menlo: 1233 / 2048,
  }
  const pct = (v: string | undefined) => {
    assert.ok(v, 'у подменного лица нет обязательной правки метрик')
    return Number.parseFloat(v!) / 100
  }
  const fallbacks = faces.filter((f) => /Fallback/i.test(f.family))
  assert.equal(fallbacks.length, 2, 'подменных лиц должно быть два: Consolas и Menlo-подобные')

  for (const f of fallbacks) {
    const names = localsOf(f)
    // Правка ширины годится ровно для того шрифта, по которому её считали:
    // первым идёт он, дальше — только другие написания его же имени и родня с
    // теми же ширинами.
    const base = names
      .map((n) => n.toLowerCase().replace(/[- ](regular|book)$/, '').replace(/[^a-z]/g, ''))
      .find((n) => n in SYSTEM)
    assert.ok(base, `${f.family}: среди local() нет шрифта, ширину которого я знаю (${names})`)
    const size = pct(f.get('size-adjust'))
    const near = (got: number, want: number, what: string) =>
      assert.ok(
        Math.abs(got - want) < 0.005,
        `${f.family}: ${what} после правок = ${got.toFixed(4)}em, а у JetBrains Mono ${want}em — ` +
          'строки будут прыгать ровно на эту разницу',
      )
    near(size * SYSTEM[base!], REAL.advance, 'ширина знака')
    near(size * pct(f.get('ascent-override')), REAL.ascent, 'верх строки')
    near(size * pct(f.get('descent-override')), REAL.descent, 'низ строки')
    assert.equal(f.get('line-gap-override'), '0%', `${f.family}: у настоящего шрифта lineGap = 0`)
  }
})

test('local() назван именем лица, а не семьи', () => {
  /*
   * `local()` ищет ЛИЦО — по полному или постскриптовому имени, — а не семью.
   * Замерено в Chrome на macOS по ширине строки из 80 «M»: local('Menlo') не
   * подходит вообще, local('Menlo-Regular') и local('Menlo Regular') подходят;
   * 'Monaco' и 'Courier New' подходят потому, что там имя семьи совпало с
   * именем регулярного лица. Пока в правиле стояло одно 'Menlo', на маке —
   * машине, с которой ведут пару, — подмены не было вовсе: семья оставалась
   * пустой, стек проваливался в неисправленный ui-monospace, и строка на 16px
   * теряла 2px против настоящего шрифта.
   */
  const TRAPS: Record<string, string[]> = { menlo: ['Menlo-Regular', 'Menlo Regular'] }
  for (const f of faces) {
    const names = localsOf(f)
    for (const [family, faceNames] of Object.entries(TRAPS)) {
      if (!names.some((n) => n.toLowerCase() === family)) continue
      assert.ok(
        names.some((n) => faceNames.includes(n)),
        `${f.family}: local('${family}') именует семью, а не лицо, и не находится — ` +
          `рядом обязано стоять хотя бы одно из ${faceNames.join(', ')}`,
      )
    }
  }
})

test('стек кода объявлен один раз и знает про подменные семьи', () => {
  const stack = /--font-mono:\s*([^;]+);/.exec(nocss(appCss))?.[1].replace(/\s+/g, ' ').trim()
  assert.ok(stack, 'web/src/index.css больше не объявляет --font-mono')
  assert.match(stack!, /^'JetBrains Mono',/, 'настоящий шрифт обязан стоять первым')
  assert.match(stack!, /monospace$/, 'у стека нет общего системного хвоста')
  for (const f of faces.filter((x) => /Fallback/i.test(x.family))) {
    assert.ok(stack!.includes(`'${f.family}'`), `${f.family} объявлено в оболочке, но в стек не попало`)
  }
  // Обратная сторона: имя в стеке, которого никто не объявляет, — это молчаливый
  // пропуск семьи, то есть подмены нет, а список выглядит так, будто она есть.
  for (const quoted of stack!.matchAll(/'([^']+)'/g)) {
    assert.ok(
      faces.some((f) => f.family === quoted[1]),
      `'${quoted[1]}' стоит в стеке, но ни одним @font-face не объявлен`,
    )
  }
  // Утилита font-mono не имеет своей копии стека: иначе тетрадь и терминал
  // расходятся ровно так, как уже расходились.
  assert.match(
    tailwind,
    /mono:\s*\['var\(--font-mono\)'\]/,
    'tailwind.config.js снова держит собственный список семейств',
  )
})

test('ни одна поверхность не набирает свой моноширинный мимо --font-mono', () => {
  /*
   * Долг по перекладке закрыт, и поблажек здесь больше нет. Своих копий стека
   * было две — `--tm-mono` ящика терминала (его же читает HistoryTab) и стек
   * внутри теневого корня html-вывода ядра; обе набирались неисправленным
   * ui-monospace до прихода woff2 и на swap двигали строки. Обе читают
   * var(--font-mono), список пуст, и любая новая копия роняет тест сразу.
   */
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    )
  const offenders: string[] = []
  for (const file of walk(resolve(ROOT, 'web/src'))) {
    if (!/\.(svelte|ts|css)$/.test(file)) continue
    const rel = relative(ROOT, file)
    const text = nocss(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/(--[\w-]+|font-family)\s*:\s*([^;{}]*monospace[^;{}]*)/g)) {
      if (rel === 'web/src/index.css' && m[1] === '--font-mono') continue
      if (m[2].trim() === 'var(--font-mono)') continue
      offenders.push(`${rel}: ${m[1]}: ${m[2].replace(/\s+/g, ' ').trim()}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'свой список семейств вместо var(--font-mono): подменные лица с правками ' +
      'метрик туда не попадут, и на swap строки поедут',
  )
})
