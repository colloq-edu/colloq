/**
 * Подписи правил комнаты: единственное место, где преподаватель читает, что
 * означает каждый переключатель.
 *
 * `RULE_ROWS` — чистый TypeScript без Svelte, и до сих пор его не проверял
 * никто. А ломается он именно молча: правило, у которого нет строки, просто
 * исчезает из панели (значение при этом действует, и никто об этом не узнает);
 * значение, которого нет в `readRules`, рисуется кнопкой, которая после нажатия
 * тихо возвращается на умолчание — то есть переключатель, обещающий не то.
 *
 * Отсюда три проверки: каждое правило комнаты названо где-то (или названо
 * здесь, что оно живёт не в этой панели), каждый вариант доживает до `readRules`
 * нетронутым, и у каждой строки есть слова.
 *
 * И четвёртая, про язык этих слов: список рисует не только панель, но и пульт
 * правил внутри комнаты, поэтому перевод «заодно с панелью» — это два имени у
 * одной настройки (решение — в шапке web/src/components/RoomRulesRows.svelte).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_ROWS } from '../web/src/lib/rule-rows.js'
import { OPEN_ROOM, readRules, type RoomRules } from '../shared/rules.js'
import { LIMITS } from '../shared/admin.js'

/**
 * Правила, у которых в этой панели строки нет — и почему.
 *
 * Список, а не молчание: правило, выпавшее из панели по недосмотру, выглядит
 * ровно так же, как правило, которое решили спрашивать в другом месте, и
 * отличить их можно только словами.
 */
const ELSEWHERE: Record<string, string> = {
  // Режим оракула — карточки на экране создания семинара (NewSeminar.svelte),
  // потому что он выбирается вместе с моделью и потолком инстанса.
  oracle: 'карточки оракула при создании семинара',
  // Модель — там же и рядом: это имя, а не переключатель.
  model: 'выбор модели при создании семинара',
  // Доступ к ОТДЕЛЬНОЙ тетради — меню на её вкладке (reader/TabStrip.svelte):
  // это не настройка комнаты, а свойство одной тетради, и спрашивают его там,
  // где на эту тетрадь смотрят. В панели за него отвечает строка `ownBooks` —
  // что получает тетрадь, которую студент заведёт себе сам.
  books: 'меню «Доступ» на вкладке тетради',
  /*
   * Сколько железа отдано личным тетрадям — блок, раскрывающийся ПОД строкой
   * `ownBooks`, когда она включена (RoomRulesRows.svelte · own-res). Своей
   * строки у него нет намеренно: это не двенадцатое право комнаты, а
   * подробность одного правила, и спрашивают её там же и тогда же, когда
   * человек это правило включает.
   */
  ownMemoryMb: 'блок «Ресурсы на все личные тетради» под строкой «Личные тетради студентов»',
  ownCpus: 'там же, рядом с памятью',
}

test('у каждого правила комнаты есть строка — или сказано, где его спрашивают', () => {
  const named = new Set(RULE_ROWS.map((row) => row.key as string))
  for (const key of Object.keys(OPEN_ROOM) as (keyof RoomRules)[]) {
    assert.ok(
      named.has(key) || key in ELSEWHERE,
      `правило ${key} не названо нигде: панель молчит, а правило действует`,
    )
  }
  for (const key of Object.keys(ELSEWHERE)) {
    assert.equal(named.has(key), false, `${key} назван и здесь, и в списке исключений`)
  }
})

test('строка на каждое правило одна: две спорили бы друг с другом', () => {
  const keys = RULE_ROWS.map((row) => row.key as string)
  assert.equal(new Set(keys).size, keys.length, 'правило названо дважды')
})

test('каждый вариант переключателя доживает до readRules нетронутым', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'choice') continue
    for (const option of row.options) {
      const read = readRules({ [row.key]: option.value }) as unknown as Record<string, unknown>
      assert.equal(
        read[row.key],
        option.value,
        `«${row.title}» предлагает ${option.value}, а комната читает ${String(read[row.key])}`,
      )
    }
  }
})

test('умолчание комнаты названо среди вариантов — иначе панель не покажет, что стоит', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'choice') continue
    const now = (OPEN_ROOM as unknown as Record<string, unknown>)[row.key]
    assert.ok(
      row.options.some((option) => option.value === now),
      `у «${row.title}» нет варианта под умолчание ${String(now)}`,
    )
  }
})

test('у каждой строки есть и название, и объяснение, и подписи у вариантов', () => {
  for (const row of RULE_ROWS) {
    assert.ok(row.title.trim().length > 0, `${row.key} без названия`)
    assert.ok(row.note.trim().length > 20, `${row.key}: подпись ничего не объясняет`)
    if (row.kind !== 'choice') continue
    assert.ok(row.options.length >= 2, `${row.key}: переключатель с одним положением`)
    for (const option of row.options) {
      assert.ok(option.label.trim().length > 0, `${row.key}: вариант без подписи`)
    }
  }
})

test('числовые строки меряются той же линейкой, что и настройка инстанса', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'limit') continue
    const ceiling = LIMITS[row.key]
    assert.ok(ceiling, `${row.key}: у комнаты есть поле, а у инстанса линейки нет`)
    assert.ok(row.min >= ceiling.min, `${row.key}: комната просит меньше, чем умеет инстанс`)
    assert.equal(row.max, ceiling.max, `${row.key}: комната просит больше, чем умеет инстанс`)
    assert.ok(row.unit.trim().length > 0, `${row.key}: число осталось голым`)
    // Ноль — не число, а особое состояние, и подпись обязана сказать словами
    // какое: «0 в час» рядом с полем ввода — это загадка, а не подсказка.
    assert.doesNotMatch(row.atInstance(0), /^0/, `${row.key}: ноль показан числом`)
    assert.match(row.atInstance(5), /5/, `${row.key}: значение инстанса не названо`)
  }
})

test('край линейки принимается комнатой, а за краем — зажимается', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'limit') continue
    const read = readRules({ [row.key]: row.max }) as unknown as Record<string, unknown>
    assert.equal(read[row.key], row.max, `${row.key}: панель предлагает край, а комната его режет`)
    const over = readRules({ [row.key]: row.max + 1 }) as unknown as Record<string, unknown>
    assert.equal(over[row.key], row.max, `${row.key}: комната приняла больше, чем умеет инстанс`)
  }
})

/*
 * Язык подписей — язык комнаты, и меняется он только вместе с ней.
 *
 * Половинчатый перевод не падает и не рисует ничего криво: он просто называет
 * правило в панели одним словом, а в комнате другим, и преподаватель, закрывший
 * тетрадь из панели, ищет в комнате переключатель, которого там нет. Проверка
 * грубая нарочно — буква кириллицы в каждой видимой строке: тонкая ловила бы
 * стиль, а поймать надо ровно один случай — «перевели панель, комнату забыли».
 * Если язык комнаты однажды сменят, эти строки поедут вместе с ней и одним
 * куском, и тогда меняется этот тест, а не половина массива.
 */
const ROOM_LANGUAGE = /[А-Яа-яЁё]/

test('подписи правил остаются в языке комнаты — панель не переводит их отдельно', () => {
  for (const row of RULE_ROWS) {
    const twoNames = `«${row.title}» переведено отдельно от комнаты: у правила ${row.key} стало два имени`
    assert.match(row.title, ROOM_LANGUAGE, twoNames)
    assert.match(row.note, ROOM_LANGUAGE, twoNames)
    if (row.kind === 'choice') {
      for (const option of row.options) assert.match(option.label, ROOM_LANGUAGE, twoNames)
    } else {
      assert.match(row.unit, ROOM_LANGUAGE, twoNames)
      // Ноль называется словами, и эти слова тоже читают в комнате.
      assert.match(row.atInstance(0), ROOM_LANGUAGE, twoNames)
    }
  }
})
