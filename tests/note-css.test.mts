/**
 * Оформление, которое текстовая ячейка приносит в чужие браузеры.
 *
 * Атрибут `style` был запрещён целиком, и запрет стоил всей привычной разметки
 * учебного ноутбука: `<div style="background:#eef;padding:8px">` доезжал голым
 * дивом, то есть неотличимо от абзаца. Теперь запрещены СВОЙСТВА, и вся
 * граница — в одной чистой функции, которую можно проверить без браузера.
 *
 * Проверяется обе стороны границы сразу: что знакомое оформление проходит (без
 * этого починка ничего не чинит) и что рычаги на чужой экран не проходят (без
 * этого она открывает дыру, ради закрытия которой запрет и стоял).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTE_CSS_PROPS, safeStyle } from '../shared/note-css.js'

/** Свойства, названные в уцелевшем объявлении. */
const props = (value: string): string[] =>
  safeStyle(value)
    .split(';')
    .map((decl) => decl.split(':')[0].trim())
    .filter(Boolean)

test('врезка «Замечание» доезжает целиком', () => {
  const kept = safeStyle('background:#eef;padding:8px;border-left:3px solid #66f')
  assert.match(kept, /background: #eef/)
  assert.match(kept, /padding: 8px/)
  assert.match(kept, /border-left: 3px solid #66f/)
})

test('обычное оформление заметки проходит', () => {
  for (const decl of [
    'color: #c33',
    'background-color: rgba(0,0,0,.05)',
    'text-align: center',
    'font-weight: 600',
    'font-family: Georgia, serif',
    'margin: 12px auto',
    'width: 420px',
    'max-width: 100%',
    'border-radius: 6px',
    'display: flex',
    'gap: 8px',
    'line-height: 1.5',
    'opacity: 0.8',
    'float: right',
    'background: linear-gradient(90deg, #fff, #eef)',
  ]) {
    assert.equal(props(decl).length, 1, `${decl} — обычное оформление, а не прошло`)
  }
})

test('чёрный экран на всю комнату не собирается', () => {
  // Та самая мера из sanitize.ts: оверлей поверх интерфейса, после которого
  // ячейку нельзя удалить мышью, а перезагрузка возвращает её же.
  assert.equal(safeStyle('position:fixed;inset:0;background:#000;z-index:9999'), 'background: #000')
  for (const decl of [
    'position: absolute',
    'position: sticky',
    'top: 0',
    'left: 0',
    'inset: 0',
    'z-index: 9999',
    'transform: scale(40)',
    'translate: 0 -400px',
    'scale: 30',
    'rotate: 45deg',
    'filter: invert(1)',
    'backdrop-filter: blur(20px)',
    'mix-blend-mode: difference',
    'clip-path: circle(99%)',
    'pointer-events: none',
    'cursor: none',
    'animation: spin 1s infinite',
    'transition: all 9s',
    'content: "x"',
    'will-change: transform',
    'contain: none',
    'zoom: 40',
    'user-select: none',
    'all: unset',
    'view-transition-name: x',
    'anchor-name: --x',
  ]) {
    assert.deepEqual(props(decl), [], `${decl} — рычаг на чужой экран, а прошло`)
  }
})

test('тень не рисует за пределами своего элемента', () => {
  // `box-shadow: 0 0 0 100vmax #000` закрашивает экран целиком, и делает это
  // без `position` — то есть мимо всего, чем от оверлея закрывались.
  assert.deepEqual(props('box-shadow: 0 0 0 100vmax #000'), [])
  assert.deepEqual(props('text-shadow: 1500px 0 0 #000'), [])
  assert.deepEqual(props('outline: 9999px solid #000'), [])
})

test('адрес из заметки никто не запрашивает', () => {
  // Тот же довод, что и у `@import` в теневом корне вывода: правило можно
  // ограничить элементом, а запрос из браузера каждого в комнате — уже нет.
  assert.deepEqual(props('background: url(http://tracker.example/x.png)'), [])
  assert.deepEqual(props('background-image: url("data:image/svg+xml,<svg/>")'), [])
  assert.deepEqual(props('list-style-image: url(x.png)'), [])
  assert.deepEqual(props('background: #fff url(x.png) no-repeat'), [])
})

test('счёт мимо потолка не проносится', () => {
  // calc/var/env считают, а значит умеют выдать число, которого в исходнике
  // нет: `calc(100vw * 40)` под разбор длин не попадёт.
  assert.deepEqual(props('width: calc(100vw * 40)'), [])
  assert.deepEqual(props('color: var(--bg)'), [])
  assert.deepEqual(props('padding: max(9999px, 1px)'), [])
  assert.deepEqual(props('width: env(safe-area-inset-left)'), [])
})

test('длина упирается в потолок, в какой единице её ни напиши', () => {
  assert.deepEqual(props('width: 420px'), ['width'])
  assert.deepEqual(props('width: 5000px'), [])
  assert.deepEqual(props('border: 9999px solid #000'), [])
  assert.deepEqual(props('margin-left: -9999px'), [])
  assert.deepEqual(props('width: 300em'), [])
  assert.deepEqual(props('height: 200in'), [])
  assert.deepEqual(props('width: 100vw'), [])
  assert.deepEqual(props('width: 900%'), [])
  // Проценты остаются процентами: без них не написать ни ширины, ни кегля.
  assert.deepEqual(props('width: 100%'), ['width'])
  assert.deepEqual(props('font-size: 150%'), ['font-size'])
  // Отрицательная отбивка на приём — да, на вынос блока из ячейки — нет.
  assert.deepEqual(props('margin-top: -6px'), ['margin-top'])
  assert.deepEqual(props('margin-top: -900px'), [])
})

test('кегль не занимает собой экран', () => {
  assert.deepEqual(props('font-size: 28px'), ['font-size'])
  assert.deepEqual(props('font-size: 400px'), [])
})

test('escape в значении разбирать никто не будет', () => {
  // `\70 osition` браузер читает как `position`. Разбирать такое — писать
  // второй разборщик CSS; в настоящей заметке escape не встречается вовсе.
  assert.equal(safeStyle('\\70 osition: fixed; inset: 0'), '')
  assert.equal(safeStyle('color: red; <script>'), '')
  assert.equal(safeStyle('color: red } * { display: none'), '')
})

test('соседство не наказывается', () => {
  // Отбрасывается объявление, а не весь атрибут: врезка не должна пропадать
  // из-за того, что рядом с ней написали запрещённое.
  assert.deepEqual(props('background:#eef;position:fixed;padding:8px'), ['background', 'padding'])
})

test('!important снимается, а не отменяет объявление', () => {
  // Инлайновый стиль и так сильнее правил `.prose-note`, автору он не даёт
  // ничего — а заметка, скопированная из чужого ноутбука, несёт его сплошь.
  assert.equal(safeStyle('color: red !important'), 'color: red')
})

test('пустой ответ значит «снять атрибут»', () => {
  assert.equal(safeStyle(''), '')
  assert.equal(safeStyle('position: fixed'), '')
  assert.equal(safeStyle('x'.repeat(3000)), '')
})

test('в белом списке нет ничего из того, чем накрывают экран', () => {
  for (const prop of [
    'position',
    'z-index',
    'top',
    'right',
    'bottom',
    'left',
    'inset',
    'transform',
    'translate',
    'rotate',
    'scale',
    'filter',
    'backdrop-filter',
    'box-shadow',
    'text-shadow',
    'outline',
    'clip-path',
    'mask',
    'animation',
    'transition',
    'content',
    'cursor',
    'pointer-events',
    'user-select',
    'will-change',
    'contain',
    'zoom',
    'all',
    'background-attachment',
  ]) {
    assert.ok(!NOTE_CSS_PROPS.has(prop), `${prop} в белом списке заметки`)
  }
})
