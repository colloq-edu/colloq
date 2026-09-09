import { tr } from '@shared/i18n'
/**
 * Скопировать текст там, где `navigator.clipboard` нет.
 *
 * Асинхронный буфер обмена живёт только в защищённом контексте: https или
 * localhost. Семинар, поднятый на кафедре по http://10.0.0.5:5173 — обычный
 * способ им пользоваться, и в нём весь `navigator.clipboard` попросту
 * `undefined`. Каждая кнопка «скопировать» падала в свой catch и в лучшем
 * случае печатала ссылку на экран, а в SessionScreen молча ничего не делала.
 *
 * Старый `document.execCommand('copy')` в этом контексте работает. Он объявлен
 * устаревшим, и правильно — но замена ему не полагается там, где его
 * вызывают, так что он остаётся запасным ходом, пока стоят такие установки.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Разрешение не дали или контекст всё-таки не тот — вниз, к запасному.
    }
  }

  const field = document.createElement('textarea')
  field.value = text
  // Вне экрана, но в документе и не hidden: из невидимого поля не копируется.
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '-1000px'
  field.style.opacity = '0'
  document.body.append(field)

  // Что было выделено до нажатия — не наше, и вернуть это обязаны мы.
  const selection = document.getSelection()
  const had = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  try {
    field.select()
    field.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error(tr('room.ui.1043'))
  } finally {
    field.remove()
    if (had && selection) {
      selection.removeAllRanges()
      selection.addRange(had)
    }
  }
}
