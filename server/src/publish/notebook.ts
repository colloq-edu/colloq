/**
 * Тетрадь публикации файлом .ipynb.
 *
 * Единственный способ унести код с собой целиком: в комнате экспорта нет
 * вовсе, а выделить мышью через несколько ячеек нельзя — каждая из них
 * отдельный редактор CodeMirror.
 *
 * Отдаётся названный шаг, а без номера — последний, то есть тетрадь на момент
 * публикации. Выводы в файл не кладутся: notebook без них открывается везде и
 * весит килобайты, с ними — мегабайты base64 в файле, который студент несёт к
 * себе, чтобы запустить заново, и первым делом всё равно нажмёт «Run».
 */
import { writeIpynb } from '@shared/ipynb'
import type { PublicCell } from '@shared/publish'
import { readStep, stepHeadings } from './store.js'

/**
 * Тетрадь из уже прочитанных ячеек — файлом .ipynb.
 *
 * Сам файл пишет общий `writeIpynb` (shared/ipynb.ts) — тот же, которым комната
 * проецирует свои тетради на диск. Здесь оставалась вторая копия того же
 * формата, и она уже разошлась с первой: `id` у ячейки был только у неё, при
 * том что схему 4.5 объявляли обе. Разошлись бы и дальше — молча, потому что
 * ошибку такого файла увидел бы не тот, кто его записал, а студент, открывший
 * его у себя.
 */
export function notebookFrom(cells: PublicCell[]): string {
  return writeIpynb(cells.map((cell) => ({ id: cell.id, type: cell.type, source: cell.source })))
}

export function notebookOf(pub: string): string {
  return notebookOfStep(pub, null)
}

/**
 * Тетрадь названного шага — или последнего, если шаг не назвали.
 *
 * Ссылка на странице была одна на все шаги, а читатель на ней стоит на своём:
 * тот, кто сравнивал «до» и «после» на шаге 2 из 5, уносил состояние шага 5.
 * Теперь страница шлёт свой номер в `?step=` (ReaderScreen.svelte, ссылка
 * «Скачать тетрадь»). Незнакомый номер отвечает последним шагом, а не
 * пустотой: скачивание — не место, где человеку объясняют про адреса, и
 * `notebookOf` про это никогда и не спрашивал.
 */
export function notebookOfStep(pub: string, seq: number | null): string {
  const headings = stepHeadings(pub)
  const wanted = seq !== null && headings.some((h) => h.seq === seq) ? seq : headings.at(-1)?.seq
  const step = wanted === undefined ? null : readStep(pub, wanted)
  return notebookFrom(step?.cells ?? [])
}
