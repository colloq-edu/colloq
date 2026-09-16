/**
 * What a text cell may not carry into everybody else's browser.
 *
 * The notebook is one shared document, so a markdown cell one student types is
 * rendered in every other person's tab, the teacher's included. DOMPurify takes
 * the script out of it: measured by writing fourteen payloads into a live
 * seminar from a second client and reading the result in a real browser, none
 * of them ran — no <script>, no on* attribute, no javascript: href survived.
 *
 * What survived is listed below, and every item on the list is a lever on
 * people other than its author.
 *
 * `style` is not scoped to the cell. `<style>* { display: none }</style>` in a
 * text cell blanks the seminar for the whole room, and `<style>@import
 * "http://…"</style>` had every browser in the room fetch a stranger's URL.
 * A stylesheet reaches the whole page, so it is the one piece of styling a
 * note still may not carry — the style ATTRIBUTE reaches one element, and that
 * one is now filtered by value instead of banned (shared/note-css.ts).
 *
 * `form` survives with its action intact, which puts a button in the middle of
 * the notebook that posts wherever its author chose.
 *
 * `audio` and `video` survive with `autoplay` and `loop`, which is sound in
 * everybody's room that its author does not have to be able to stop.
 *
 * Kernel output keeps all of them, and NOT because output is trusted. The old
 * argument here — "anybody who can make the kernel emit HTML can already run
 * whatever they like" — is about the kernel's container, not about the browsers
 * of the other five hundred people: code in the container cannot blank a
 * classmate's screen, and one `display(HTML(...))` with a hiding rule did
 * exactly that, room-wide and on the projector, for as long as the output
 * stayed in the document.
 *
 * `df.style` is a real pandas feature and it emits a scoped <style>, so the
 * tag stays — the containment is done by construction instead of by a ban:
 * kernel HTML and SVG are drawn inside a shadow root (components/notebook/
 * ScopedOutput.svelte), where a stylesheet reaches only its own subtree,
 * `contain: paint` on the host takes the page away from `position: fixed`, and
 * `@import` is stripped in an inert <template> before the markup moves in.
 * That is the whole reason the list above may be shorter for output than for a
 * note: a note is rendered straight into the page, output never is.
 */
export const MARKDOWN_FORBIDDEN_TAGS = ['style', 'form', 'audio', 'video']

/**
 * И атрибут `style` — он же был половиной той самой дыры.
 *
 * Запрета здесь больше нет, и вот почему он тут стоял. Тег `<style>` запрещён,
 * а АТРИБУТ DOMPurify оставляет по умолчанию и значение его не разбирает вовсе:
 * ни CSS, ни адресов внутри. `<div style="position:fixed;inset:0;
 * background:#000;z-index:9999">` из одной текстовой ячейки — чёрный экран у
 * всех тридцати человек и у ноутбука в проекторе, причём поверх интерфейса:
 * удалить ячейку мышью уже нельзя, а перезагрузка возвращает ту же ячейку.
 *
 * Запрет это закрывал, но вместе с дырой уносил всю привычную разметку учебной
 * тетради: `<div style="background:#eef;padding:8px">` — врезка «Замечание» из
 * каждого второго ноутбука — доезжала голым `<div>`, то есть неотличимо от
 * абзаца. Читалось это не как «оформление запрещено», а как «HTML не
 * работает»: структура-то проходила, а видимой разницы не было.
 *
 * Теперь запрещён не атрибут, а СВОЙСТВА, и считает их одно место —
 * shared/note-css.ts · safeStyle. `background`, `padding`, `border`, `color`,
 * `text-align`, `width` проходят; `position`, `z-index`, `transform`,
 * `box-shadow`, `url(...)` — нет, и длины упираются в потолок. Санитайзер
 * атрибут не трогает, а render.svelte.ts переписывает его значение ДО того,
 * как разметка попадёт в страницу: пока она лежит в отцепленном узле, ни одно
 * правило из неё не действует и ни один адрес из неё не запрашивается.
 *
 * Остаётся `ping`: DOMPurify оставляет его по умолчанию, и `<a href="…"
 * ping="http://…">` — это POST на чужой адрес из браузера того, кто нажал на
 * ссылку в чужой заметке. Оформлению он не нужен, а рычаг на читателя — самый
 * настоящий, и виден он только в исходнике ссылки.
 *
 * `input` и `canvas` в списке тегов НЕТ намеренно: чекбокс — это список задач
 * из GFM (`- [ ] сделать`), а холст без скрипта, которого сюда не пронести,
 * не рисует ничего.
 */
export const MARKDOWN_FORBIDDEN_ATTRS = ['ping']
