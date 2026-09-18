/**
 * Лендинг открывают оттуда, где Google не отвечает.
 *
 * Страница colloq.ru — единственное, что читают до всякого входа, и читают её
 * из университетской сети без выхода наружу и из России, где внешние CDN уже
 * перекрывали. Пока моноширинный приезжал с fonts.googleapis.com, терминал в
 * герое рисовался системным шрифтом с другими ширинами — команда переставала
 * попадать в свою строку, и увидеть это с машины автора было нельзя.
 *
 * Проверяется не «стало быстрее», а факт: за шрифтами страница больше никуда
 * не ходит, всё, что она предзагружает, у неё есть и правда набирается, а
 * подменный шрифт разведён по двум РАЗНЫМ именам и назван именами лиц — иначе
 * подмены нет вовсе и терминал в герое едет строкой ровно там, где её читают.
 * Комментарии при этом вырезаются — в них эти адреса названы вслух, и запрет
 * на слово запретил бы объяснение.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const html = read('site/index.html')
/**
 * Английская страница лежит на этаж глубже, и адреса у неё корневые. Проверять
 * надо обе: забыть crossorigin или сослаться на несуществующий файл можно ровно
 * на той, которую в этот раз не открывали.
 */
const pages: Array<[string, string]> = [
  ['ru', html],
  ['en', read('site/en/index.html')],
]
/** «/fonts/x.woff2» и «fonts/x.woff2» — один и тот же файл в site/. */
const inSite = (href: string) => href.replace(/^\//, '')
const css = readFileSync(resolve(ROOT, 'site/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('за шрифтами лендинг никуда не ходит', () => {
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    for (const [name, page] of pages) {
      assert.ok(
        !page.includes(host),
        `${name}: шрифт снова тянется с ${host}: в изолированной сети страница ` +
          'наберётся системным моноширинным, у которого другие ширины',
      )
    }
    assert.ok(!css.includes(host), `шрифт снова тянется с ${host} из стилей`)
  }
  // И ни одного шрифта с чужого домена вообще: свои лежат рядом, в site/fonts.
  for (const src of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
    assert.match(src[1], /^fonts\//, `${src[1]} — шрифт не из site/fonts`)
    assert.ok(existsSync(resolve(ROOT, 'site', src[1])), `${src[1]} объявлен, а файла нет`)
  }
})

test('предзагружается ровно то, чем страница набрана', () => {
  for (const [name, page] of pages) {
    const preloads = [...page.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0])
    assert.ok(preloads.length > 0, `${name}: не осталось ни одной предзагрузки шрифта`)
    for (const tag of preloads) {
      const href = /href="([^"]+)"/.exec(tag)?.[1]
      assert.ok(href, `${name}: предзагрузка без адреса`)
      const rel = inSite(href)
      assert.ok(existsSync(resolve(ROOT, 'site', rel)), `${name}: ${href} предзагружается, а файла нет`)
      // Файл, которого нет ни в одном @font-face, — это лишний запрос на пути к
      // первому кадру и предупреждение в консоли, а не забота о скорости.
      assert.ok(css.includes(rel), `${name}: ${href} предзагружается, но ни одним @font-face не набран`)
      // Без crossorigin шрифт скачается дважды: он запрашивается в режиме CORS.
      assert.match(
        tag,
        /crossorigin/,
        `${name}: ${href} предзагружается без crossorigin — это второй запрос`,
      )
    }
  }
})

/** Каждое @font-face лендинга: имя семейства и его дескрипторы. */
type Face = { family: string; body: string; get(d: string): string | undefined }
const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1]
  const get = (d: string) =>
    new RegExp(`(?:^|;)\\s*${d}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim()
  return { family: (get('font-family') ?? '').replace(/['"]/g, ''), body, get }
})
/** Имена, которые перечисляет `src: local(...)` одного лица. */
const localsOf = (f: Face) =>
  [...(f.get('src') ?? '').matchAll(/local\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1].trim())

test('одно имя — одно лицо: подменные семьи разведены', () => {
  /*
   * Два @font-face под ОДНИМ именем, оба без unicode-range и с одним
   * начертанием, — ставка на поведение реализации: спецификация не обещает,
   * что браузер, выбрав лицо и не найдя у него ни одного local(), переберёт
   * остальные лица той же семьи, а не бросит семью целиком. Ровно так подмена
   * и могла бы пропасть на Windows. Разные имена — обычный перебор семейств,
   * который обещан.
   */
  const seen = new Set<string>()
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
        'какое из двух возьмёт браузер и что будет, если у него не найдётся ни ' +
        'одного local(), решает реализация, а не мы',
    )
    seen.add(key)
  }
})

test('local() назван именем лица, а не семьи', () => {
  /*
   * `local()` ищет ЛИЦО — по полному или постскриптовому имени, — а не семью.
   * Замерено в Chrome на macOS по ширине строки из 80 «M»: local('Menlo') не
   * подходит вообще, local('Menlo-Regular') и local('Menlo Regular') подходят.
   * Пока в правиле стояло одно 'Menlo', на маке подмены не было вовсе: семья
   * оставалась пустой, стек проваливался в неисправленный ui-monospace, и
   * строка терминала на 16px теряла 2px против настоящего шрифта.
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

test('стек страницы знает про обе подменные семьи', () => {
  const stack = /--mono:\s*([^;]+);/.exec(css)?.[1].replace(/\s+/g, ' ').trim()
  assert.ok(stack, 'site/styles.css больше не объявляет --mono')
  assert.match(stack!, /^'JetBrains Mono',/, 'настоящий шрифт обязан стоять первым')
  assert.match(stack!, /monospace$/, 'у стека нет общего системного хвоста')
  const fallbacks = faces.filter((f) => /Fallback/i.test(f.family))
  assert.equal(fallbacks.length, 2, 'подменных лиц должно быть два: Consolas и Menlo-подобные')
  for (const f of fallbacks) {
    assert.ok(stack!.includes(`'${f.family}'`), `${f.family} объявлено, но в --mono не попало`)
  }
  // Имя в стеке, которого никто не объявляет, — молчаливый пропуск семьи: подмены
  // нет, а список выглядит так, будто она есть.
  for (const quoted of stack!.matchAll(/'([^']+)'/g)) {
    assert.ok(
      faces.some((f) => f.family === quoted[1]),
      `'${quoted[1]}' стоит в стеке, но ни одним @font-face не объявлен`,
    )
  }
  // Обе подменные — между настоящим шрифтом и системным хвостом, подряд: за
  // ui-monospace они уже не спасают, потому что до них не дойдут.
  const names = stack!.split(', ')
  const first = names.findIndex((n) => /Fallback/.test(n))
  assert.equal(names[0], "'JetBrains Mono'", 'настоящий шрифт обязан стоять первым')
  assert.ok(
    /Fallback/.test(names[first + 1] ?? ''),
    'подменные семьи стоят не подряд — между ними влез шрифт без правок метрик',
  )
  assert.match(
    names[first + 2] ?? '',
    /^ui-monospace/,
    'системный хвост обязан идти после обеих подменных, а не до',
  )
})

test('у самохоста шрифта лежит его лицензия', () => {
  // JetBrains Mono под SIL OFL 1.1: хостить и резать его можно, но текст
  // лицензии обязан ехать вместе с файлами.
  assert.ok(
    existsSync(resolve(ROOT, 'site/fonts/JetBrainsMono-OFL.txt')),
    'шрифт положили, а лицензию — нет',
  )
})
