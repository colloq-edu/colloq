/**
 * Файл, который тащат в папку, и всё, чем этот жест кончается.
 *
 * Проверяется не арифметика путей, а то, что комната увидит на экране: где
 * окажется запись, когда переносить нечего и о чём при этом молчат. Правила
 * здесь стоят раньше сервера намеренно: до сервера дело не доходит вовсе —
 * цель, помеченную «нельзя», браузер не отдаёт, события `drop` не будет, и
 * читают всегда ЗДЕШНЮЮ фразу. Значит, она обязана совпадать со словами
 * сервера дословно, а не по смыслу.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deepestAfter,
  dropFolder,
  landingPath,
  longestAfter,
  movedPaths,
  planMove,
  readsInside,
  type Row,
} from '../web/src/lib/tree-move.js'
import { parentOf } from '../shared/paths.js'
import type { FileEntry } from '../shared/protocol.js'

function file(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, dir: false, size: 12, modifiedAt: 0 }
}
function dir(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, dir: true, size: 0, modifiedAt: 0 }
}
/** Строка дерева так, как её берёт в руку панель. */
function row(entry: FileEntry): Row {
  return { path: entry.path, dir: entry.dir }
}

/** Папка семинара в том же порядке, в каком её рисуют. */
const TREE: FileEntry[] = [
  dir('data'),
  file('data/train.csv'),
  dir('src'),
  dir('src/deep'),
  file('src/model.py'),
  file('README.md'),
  file('train.csv'),
]

test('файл переезжает в папку — и только тогда уходит сообщение', () => {
  const plan = planMove(row(file('README.md')), row(dir('src')), TREE)
  assert.deepEqual(plan, { do: 'move', from: 'README.md', to: 'src/README.md' })
})

test('папка, брошенная на саму себя, никуда не едет — и об этом не сообщают', () => {
  /*
   * Промах пальцем, а не ошибка. Отказ здесь читался бы как «папку нельзя
   * трогать вовсе», и человек перестал бы пробовать.
   */
  assert.deepEqual(planMove(row(dir('src')), row(dir('src')), TREE), { do: 'nothing' })
  // И бросок папки на файл, лежащий прямо в ней, — тот же самый жест.
  assert.deepEqual(planMove(row(dir('src')), row(file('src/model.py')), TREE), { do: 'nothing' })
})

test('папку нельзя положить в свою же подпапку, и сказано это про место, а не про имя', () => {
  /*
   * Доехав до сервера, этот жест возвращается фразой «„deep“ не годится в
   * качестве имени»: сервер отказывает верно, а объясняет именем цели. Имя как
   * раз годится — не годится место, и об этом должны сказать здесь.
   */
  const plan = planMove(row(dir('src')), row(dir('src/deep')), TREE)
  assert.equal(plan.do, 'refuse')
  assert.equal(
    plan.do === 'refuse' ? plan.why : '',
    '«src» нельзя переместить внутрь себя.',
    'отказ объясняет не то: имя вместо места',
  )
})

test('файл, брошенный в свою же папку, не поднимает tree:move', () => {
  // Иначе каждый несостоявшийся жест — круг по сети и моргание всего списка.
  assert.deepEqual(planMove(row(file('src/model.py')), row(dir('src')), TREE), { do: 'nothing' })
  assert.deepEqual(planMove(row(file('src/model.py')), row(file('src/model.py')), TREE), {
    do: 'nothing',
  })
  // И запись, которая уже лежит в корне, брошенная мимо строк.
  assert.deepEqual(planMove(row(file('README.md')), null, TREE), { do: 'nothing' })
})

test('брошенное на файл ложится в его папку, а не поверх него', () => {
  /*
   * То же правило, по которому кладут файл, перетащенный с диска. Разойдясь,
   * они на один и тот же жест положили бы файл в разные места.
   */
  assert.equal(dropFolder(row(file('src/model.py'))), 'src')
  assert.equal(dropFolder(row(dir('src'))), 'src')
  assert.equal(landingPath(row(file('README.md')), row(file('src/model.py'))), 'src/README.md')
  assert.deepEqual(planMove(row(file('README.md')), row(file('src/model.py')), TREE), {
    do: 'move',
    from: 'README.md',
    to: 'src/README.md',
  })
})

test('брошенное мимо строк ложится в корень', () => {
  // Пустое место панели — это корень папки семинара, а не «никуда».
  assert.equal(dropFolder(null), '')
  assert.deepEqual(planMove(row(file('src/model.py')), null, TREE), {
    do: 'move',
    from: 'src/model.py',
    to: 'model.py',
  })
})

test('занятое имя названо вместе с папкой, в которой оно занято', () => {
  /*
   * `train.csv` лежит и в корне, и в `data`. «В этой папке» указывало на ту, ИЗ
   * которой тащат, — то есть на корень, где столкновения нет, — и человек шёл
   * искать несуществующую вторую копию. Сервер это уже различает
   * (`treeTrouble`), но его фразы не видит никто: цель с «нельзя» события `drop`
   * не отдаёт, и читают всегда эту.
   */
  const plan = planMove(row(file('train.csv')), row(dir('data')), TREE)
  assert.equal(plan.do, 'refuse')
  assert.equal(plan.do === 'refuse' ? plan.why : '', '«train.csv» в папке «data» уже есть.')
  // Занять имя может и папка — сервер откажет и в этом случае.
  const twins: FileEntry[] = [dir('a'), dir('a/deep'), dir('b'), dir('b/deep')]
  const folders = planMove(row(dir('a/deep')), row(dir('b')), twins)
  assert.equal(folders.do === 'refuse' ? folders.why : '', '«deep» в папке «b» уже есть.')
  // У корня имени нет, и «в папке „“» было бы дырой в фразе.
  const home = planMove(row(file('data/train.csv')), null, TREE)
  assert.equal(home.do === 'refuse' ? home.why : '', '«train.csv» в корне комнаты уже есть.')
})

test('папка, чьё содержимое на новом месте уходит глубже потолка, не переезжает', () => {
  /*
   * Восемь сегментов — потолок адресации. Сервер смотрит только на путь папки
   * и такой переезд исполняет; после него обход дерева до содержимого просто не
   * доходит, флага «показано не целиком» не выставляет, и поддерево пропадает
   * из панели молча — открыть, скачать и убрать его будет нечем.
   */
  const deep: FileEntry[] = [
    dir('a'),
    dir('a/b'),
    dir('a/b/c'),
    dir('a/b/c/d'),
    dir('a/b/c/d/e'),
    dir('a/b/c/d/e/f'),
    dir('a/b/c/d/e/f/g'),
    file('a/b/c/d/e/f/g/x.py'),
    dir('data'),
  ]
  assert.equal(deepestAfter(row(dir('a')), 'data', deep), 9, 'глубину считают по самой папке')
  const plan = planMove(row(dir('a')), row(dir('data')), deep)
  assert.equal(plan.do, 'refuse')
  assert.equal(
    plan.do === 'refuse' ? plan.why : '',
    'Допустимая глубина пути — до 8 уровней.',
  )
  // Ровно на потолок — можно: правило про то, что не влезает, а не про запас.
  assert.equal(planMove(row(dir('a/b')), row(dir('data')), deep).do, 'move')
})

test('того, чего в списке уже нет, не перетаскивают', () => {
  // Строку держали в руке, пока пришёл новый список: файл убрали, папку
  // переименовали. Отправить `tree:move` значило бы получить отказ на круг
  // позже и не в панель, а в общую полосу ошибок.
  const plan = planMove(row(file('old.csv')), row(dir('data')), TREE)
  assert.equal(plan.do, 'refuse')
  assert.equal(plan.do === 'refuse' ? plan.why : '', '«old.csv» в комнате больше нет.')
})

test('подсветка целится в ту же папку, куда запись и ляжет', () => {
  /*
   * Панель подсвечивает `dropFolder`, а посылает `plan.to`. Разойдясь, они
   * дадут строку, которая светится на одной папке, а файл кладёт в другую, — и
   * человек пойдёт искать его глазами не туда. Проверяется на всех парах
   * дерева разом: правило одно для файла, папки и пустого места.
   */
  const spots: (FileEntry | null)[] = [...TREE, null]
  for (const dragged of TREE) {
    for (const onto of spots) {
      const here = onto ? row(onto) : null
      const plan = planMove(row(dragged), here, TREE)
      if (plan.do !== 'move') continue
      const where = onto?.path ?? '(корень)'
      assert.equal(plan.to, landingPath(row(dragged), here), `${dragged.path} → ${where}`)
      assert.equal(
        parentOf(plan.to),
        dropFolder(here),
        `подсветка и переезд разошлись на ${dragged.path} → ${where}`,
      )
    }
  }
})

test('папка уводит за собой вкладки всего, что в ней', () => {
  /*
   * Вкладка знает ТОЧНЫЙ путь: сказать ей одно имя папки — значит не сдвинуть
   * ни одной из тех, ради которых папку и таскают. Следом приходит список
   * файлов, вкладка на `src/model.py` в нём не находится и закрывается вместе с
   * документом — то есть с набранным и историей отмен, а если она была
   * активной, центр комнаты пустеет.
   */
  assert.deepEqual(movedPaths('src', 'data/src', TREE), [
    { from: 'src', to: 'data/src' },
    { from: 'src/deep', to: 'data/src/deep' },
    { from: 'src/model.py', to: 'data/src/model.py' },
  ])
  // Файл говорит о себе одном.
  assert.deepEqual(movedPaths('README.md', 'src/README.md', TREE), [
    { from: 'README.md', to: 'src/README.md' },
  ])
  // Сосед с тем же началом имени — не содержимое: `src2` начинается на `src`,
  // а внутри `src` не лежит, и увезти его вкладку значило бы потерять её.
  const twins: FileEntry[] = [dir('src'), file('src/a.py'), dir('src2'), file('src2/b.py')]
  assert.deepEqual(movedPaths('src', 'x/src', twins), [
    { from: 'src', to: 'x/src' },
    { from: 'src/a.py', to: 'x/src/a.py' },
  ])
})

test('внутрь папки на самом дне сервер не заглядывает — и «пусто» про неё неправда', () => {
  /*
   * `listTree` читает каталоги, пока их содержимое помещается в восемь
   * сегментов, и флага «показано не целиком» при этом не ставит: он считает
   * только строки. Панель без этого вопроса рисовала «пусто» под папкой, в
   * которой лежат файлы, — и звала убрать её как пустую.
   */
  assert.equal(readsInside(''), true, 'корень читают всегда')
  assert.equal(readsInside('a/b/c/d/e/f/g'), true, 'седьмой уровень сервер ещё обходит')
  assert.equal(readsInside('a/b/c/d/e/f/g/h'), false, 'до дна обход не доходит никогда')
})

test('папка, чьё содержимое на новом месте не помещается в длину пути, не переезжает', () => {
  /*
   * Та же дыра, что и с глубиной, только по символам: длину меряют у того пути,
   * который прислали, а он короткий. Содержимое уезжает за четыреста символов —
   * и после этого его не открыть, не скачать и не убрать поштучно
   * (`normalizePath` такой путь не пропускает), а место оно занимает. На
   * «Убрать» приходила фраза не про то: «„data.csv“ не годится в качестве
   * имени».
   */
  const long = 'a'.repeat(120)
  const far = 'b'.repeat(40)
  const tree: FileEntry[] = [
    dir(long),
    dir(`${long}/${long}`),
    dir(`${long}/${long}/${long}`),
    file(`${long}/${long}/${long}/data.csv`),
    dir(far),
    dir('x'),
  ]

  assert.equal(longestAfter(row(dir(long)), far, tree), 412, 'длину считают по самой папке')
  const plan = planMove(row(dir(long)), row(dir(far)), tree)
  assert.equal(plan.do, 'refuse')
  assert.equal(
    plan.do === 'refuse' ? plan.why : '',
    `«${long}» нельзя переместить: путь к содержимому превысит 400 символов.`,
  )
  // Та же папка на короткое имя — можно: правило про то, что не влезает, а не
  // про запас.
  assert.equal(planMove(row(dir(long)), row(dir('x')), tree).do, 'move')
})
