/**
 * Меню строки в панели файлов — состав, права и манера.
 *
 * Всё здесь читается из исходников, как в `panels-craft.test.mts`, и по той же
 * причине: состав меню и то, каким правилом гаснет каждый пункт, нельзя
 * проверить ни чистой функцией, ни сокетом — это разметка. А ломается она
 * молча: пункт, погашенный не тем правилом, выглядит ровно так же, как
 * погашенный тем, и человек идёт искать преподавателя, который ничего не
 * запрещал.
 *
 * Второе, что здесь закреплено, — уроки, купленные на живом стенде. Подложка
 * нижнего листа без своего обработчика, кнопка «⋯» с целью в сорок пикселей,
 * возврат фокуса на строку: каждое из этих мест уже ломалось один раз, и
 * каждое откатывается одной строкой.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomMessages } from '../shared/locales/room.js'
import { serverMessages } from '../shared/locales/server.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и код без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const FILES = 'web/src/components/panels/FilesPanel.svelte'
const MENU = 'web/src/components/ui/ContextMenu.svelte'

/** Тело функции от её объявления до следующего объявления того же уровня. */
function body(source: string, from: string, to: string): string {
  const at = source.indexOf(from)
  assert.ok(at > 0, `не нашли ${from}`)
  const end = source.indexOf(to, at)
  assert.ok(end > at, `не нашли ${to} после ${from}`)
  return source.slice(at, end)
}

/* --------------------------------------------------------- состав меню */

test('меню файла идёт в одном порядке: открыть, копировать, забрать, изменить', () => {
  /*
   * Порядок не украшение. Первым — то, что делает щелчок (открыть), потом
   * безобидное (копирование и скачивание), и только последней группой —
   * необратимое. «Удалить…» стоит внизу и один, за чертой: промах мышью на
   * строку вверх не должен попадать в него.
   */
  const files = code(read(FILES))
  const menu = body(files, 'function fileItems(', 'function folderItems(')
  const order = [...menu.matchAll(/tr\('(room\.files\.menu\.[a-zA-Z]+)'\)/g)].map((m) => m[1])
  assert.deepEqual(order, [
    'room.files.menu.open',
    'room.files.menu.run',
    'room.files.menu.copyPath',
    'room.files.menu.copyName',
    'room.files.menu.download',
    'room.files.menu.duplicate',
    'room.files.menu.rename',
    'room.files.menu.remove',
  ])
  /*
   * Черты — три на четыре группы. Первая условная: у двоичного файла «Открыть»
   * нет вовсе, и черта в самом верху меню была бы чертой, над которой пусто.
   */
  assert.match(menu, /gap: items\.length > 0/)
  assert.equal([...menu.matchAll(/gap: true/g)].length, 2)
})

test('копируется путь от папки занятия и отдельно — имя', () => {
  const menu = body(code(read(FILES)), 'function fileItems(', 'function folderItems(')
  assert.match(menu, /copyItem\(path, tr\('room\.files\.menu\.copyPath'\)\)/)
  assert.match(menu, /copyItem\(entry\.name, tr\('room\.files\.menu\.copyName'\)\)/)
  // И ничего третьего: строка для ячейки («pd.read_csv(…)») из меню убрана, а
  // вместе с ней и весь `snippetFor`.
  const files = read(FILES)
  assert.ok(!files.includes('snippetFor'), 'snippetFor вернулся в панель')
  assert.ok(!files.includes('read_csv'), 'строка для ячейки вернулась в панель')
})

test('нечего открывать — нет и пункта: у двоичного файла только «Скачать»', () => {
  // Щелчок по двоичному файлу СКАЧИВАЕТ его (см. `pick`), и «Открыть» рядом со
  // «Скачать» было бы двумя подписями к одному действию.
  const menu = body(code(read(FILES)), 'function fileItems(', 'function folderItems(')
  assert.match(menu, /if \(kind !== 'binary'\)/)
})

test('меню папки заводит внутрь неё, а дублировать папку не даёт', () => {
  const folder = body(code(read(FILES)), 'function folderItems(', 'function panelItems(')
  for (const item of ['newFileHere', 'newDirHere', 'newBookHere', 'uploadHere', 'copyPath']) {
    assert.match(folder, new RegExp(`room\\.files\\.menu\\.${item}`), `нет пункта ${item}`)
  }
  assert.match(folder, /startDraftIn\('file', path\)/)
  assert.match(folder, /uploadInto\(path\)/)
  // Пункт есть, но погашен, и причина — та же фраза, которой отказал бы сервер.
  assert.match(folder, /disabled: true,[\s\S]{0,240}tr\('server\.files\.copyFolder'\)/)
})

test('пустое место панели предлагает только то, что кладут в папку занятия', () => {
  const panel = body(code(read(FILES)), 'function panelItems(', 'const menuItems')
  const order = [...panel.matchAll(/tr\('(room\.files\.menu\.[a-zA-Z]+)'\)/g)].map((m) => m[1])
  assert.deepEqual(order, [
    'room.files.menu.newFile',
    'room.files.menu.newDir',
    'room.files.menu.newBook',
    'room.files.menu.upload',
  ])
  // Ни переименования, ни удаления: у корня папки занятия нет своей строки.
  assert.ok(!panel.includes('rename'), 'в меню корня попало переименование')
  assert.ok(!panel.includes('remove'), 'в меню корня попало удаление')
})

/* --------------------------------------------------------------- права */

test('дублирование спрашивает `files`, а переименование и удаление — роль', () => {
  /*
   * Копия ДОБАВЛЯЕТ файл, как «новый файл» и как загрузка, — значит правило у
   * неё то же, `files`. Переименование и удаление УБИРАЮТ прежний путь, и они
   * преподавательские; исключение одно — своя личная тетрадь. Ровно это же
   * решает сервер (control.ts · tree:copy, tree:move, tree:remove).
   */
  const files = code(read(FILES))
  assert.match(files, /const mayRename = \$derived\(isHost && may\.files\)/)
  assert.match(files, /const mayRemove = \(path: string\): boolean => isHost \|\| myBook\(path\)/)
  const menu = body(files, 'function fileItems(', 'function folderItems(')
  assert.match(menu, /room\.files\.menu\.duplicate'\),[\s\S]{0,260}disabled: !may\.files/)
  assert.match(menu, /room\.files\.menu\.rename'\),[\s\S]{0,160}disabled: !mayRename/)
  assert.match(menu, /room\.files\.menu\.remove'\),[\s\S]{0,200}disabled: !mayRemove\(path\)/)
})

test('после звонка фраза про правило уступает фразе про занятие', () => {
  // `may.filesWhy` после звонка — это уже CLASS_IS_OVER (lib/may.ts), и
  // «переименовывает преподаватель» посреди законченного занятия отправляет
  // человека не туда.
  const files = code(read(FILES))
  assert.match(
    files,
    /const whyEdit = \$derived\(may\.files \? tr\('room\.files\.menu\.hostOnly'\) : may\.filesWhy\)/,
  )
})

test('дублирование уезжает кадром tree:copy и ничем больше', () => {
  const dup = body(code(read(FILES)), 'function duplicate(', '$effect(() => {')
  assert.match(dup, /session\.send\(\{ t: 'tree:copy', path: entry\.path \}\)/)
  assert.match(dup, /if \(!may\.files\)/, 'право не спрашивают до отправки')
  // Имя копии здесь не сочиняется: его выбирает сервер.
  assert.ok(!dup.includes('копия'), 'вкладка сочиняет имя копии сама')
})

/* ------------------------------------------------------- манера компонента */

test('меню — это меню: роли, подпись и возврат фокуса', () => {
  const menu = code(read(MENU))
  assert.match(menu, /role="menu"/)
  assert.match(menu, /role="menuitem"/)
  assert.match(menu, /aria-label=\{label\}/)
  // Escape закрывает и помечает ключ съеденным: тем же Escape комната
  // закрывает ящик терминала.
  assert.match(menu, /event\.key === 'Escape'[\s\S]{0,260}event\.stopPropagation\(\)/)
  // Фокус возвращается туда, откуда меню позвали.
  assert.match(menu, /if \(back\?\.isConnected\) back\.focus\(\)/)
})

test('меню живёт над ящиками комнаты и под окнами отказа', () => {
  // z-40 — ящики, z-50 — пульт правил, z-[96] — меню бана, z-[97] — окно
  // отказа, z-[100] — «вас удалили». Меню доступа на вкладке стоит на z-[60],
  // и это меню — там же.
  assert.match(code(read(MENU)), /z-\[60\]/)
})

test('меню въезжает и не выезжает: уход анимировать нельзя', () => {
  const menu = read(MENU)
  assert.doesNotMatch(code(menu), /transition:(fly|fade)/, 'двусторонняя директива')
  assert.match(menu, /in:fly=/)
  assert.match(menu, /import \{ quintOut \} from 'svelte\/easing'/)
  assert.match(menu, /prefersReducedMotion\(\)/)
})

test('на пальце меню приходит нижним листом с целями в 44 пикселя', () => {
  /*
   * Поповер у пальца закрывается самим пальцем и требует цели в 28 пикселей.
   * Признак тот же, которым `hoverOnlyWhenSupported` отключает `hover:`
   * утилиты, — про устройство ввода, а не про ширину окна.
   */
  const menu = code(read(MENU))
  assert.match(menu, /matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)/)
  assert.match(menu, /sheet \? 'h-11 gap-3 px-4 text-ui-lg' : 'h-7 gap-2 px-2\.5 text-ui'/)
  assert.match(menu, /inset-x-0 bottom-0/)
  assert.match(menu, /env\(safe-area-inset-bottom\)/)
})

test('подложка нижнего листа ничего не слушает сама', () => {
  /*
   * Лист открывается ДОЛГИМ нажатием: палец уже на экране, и его подъём
   * браузер отдаёт как `click` по тому, что под пальцем, — то есть по
   * подложке. Кнопка на ней закрывала лист ровно в тот миг, когда его открыли
   * (проверено на стенде). Нажатие мимо ловит общий `pointerdown`.
   */
  const menu = code(read(MENU))
  const backdrop = body(menu, 'absolute inset-0 bg-canvas/70', '</div>')
  assert.ok(!backdrop.includes('onclick'), 'подложка снова закрывает лист по click')
  assert.match(menu, /window\.addEventListener\('pointerdown', away, true\)/)
})

test('погашенный пункт называет причину строкой, а не только подсказкой', () => {
  // `title` виден под указателем и не виден пальцем никогда: на телефоне
  // погашенный пункт оставался бы немым.
  const menu = code(read(MENU))
  assert.match(menu, /data-menu-why/)
  assert.match(menu, /if \(!item\.disabled \|\| !item\.why \|\| out\.includes\(item\.why\)\) continue/)
  assert.match(menu, /title=\{item\.disabled \? \(item\.why \?\? undefined\) : undefined\}/)
})

/* ------------------------------------------------------------- словарь */

test('каждый ключ меню есть на обоих языках и без кириллицы в английском', () => {
  const used = new Set(
    [...read(FILES).matchAll(/tr\('(room\.files\.menu\.[a-zA-Z]+)'/g)].map((m) => m[1]),
  )
  assert.ok(used.size >= 20, `ключей меню подозрительно мало: ${used.size}`)
  for (const key of used) {
    const pair = roomMessages[key]
    assert.ok(pair, `нет ключа ${key}`)
    assert.ok(pair.ru && pair.en, `у ${key} не оба языка`)
    assert.doesNotMatch(String(pair.en), /[А-Яа-яЁё]/, `в английском ${key} кириллица`)
  }
  // И фраза про папку — из серверного словаря: отказывает ею сервер.
  assert.ok(serverMessages['server.files.copyFolder'])
})

test('строк прежней полосы из трёх значков в словаре не осталось', () => {
  // «Скопировать строку для ячейки», «Скачать {p0}», «Убрать {p0}» и «Копировать
  // {p0}» жили только ради значков, которых больше нет. Мёртвый ключ тянется в
  // сборку каждого экрана комнаты.
  for (const gone of [
    'room.ui.594',
    'room.ui.596',
    'room.ui.597',
    'room.extra.272',
    'room.extra.273',
    'room.extra.274',
  ]) {
    assert.ok(!(gone in roomMessages), `ключ ${gone} остался в словаре`)
  }
})

test('подсказка про правую кнопку показывается один раз и переживает приватное окно', () => {
  const files = code(read(FILES))
  assert.match(files, /const TIP_KEY = 'colloq\.files\.menuTip'/)
  // Чтение и запись — обе в try/catch: в приватном окне обращение к хранилищу
  // бросает, и подсказка не должна ронять панель.
  assert.equal([...body(files, 'function tipWasSeen(', '{@render').matchAll(/catch \{/g)].length, 2)
  assert.match(files, /\{#if !tipSeen && listed\}/)
})

test('кружки присутствия не уходят под «⋯»: место под кнопку отведено заранее', () => {
  const files = code(read(FILES))
  /*
   * 20.09.2026 с пары: «три точки перекрывают кружочки, видно половину
   * первого». Кнопка лежит абсолютом у правого края и закрашена, поэтому
   * полоса кружков обязана кончаться левее неё — и всегда, а не по наведению:
   * указатель идёт как раз к «⋯», и сдвиг под ним читался бы как поломка.
   */
  const lane = body(files, '{#if here.length > 0}', '{:else if !entry.dir}')
  assert.match(lane, /class="flex items-center gap-1 pr-\[26px\]"/)
  assert.doesNotMatch(lane, /group-hover:/, 'кружки не должны двигаться под указателем')
  // И сама кнопка по-прежнему стоит абсолютом у правого края — иначе отступ
  // выше отводит место не тому.
  assert.match(files, /class="absolute inset-y-0 right-0 flex items-center bg-raised/)
})
