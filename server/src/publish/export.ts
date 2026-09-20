/**
 * Выгрузка публикаций в статический сайт.
 *
 * Каталог на курс и каталог на шаг, в каждом обычный `index.html`. Ни API, ни
 * маршрутизации, ни скриптов: страница, которую студент открывает в среду
 * вечером, не должна зависеть от того, включён ли ноутбук преподавателя.
 *
 * Пишется только в свои подкаталоги — `c/` и `p/`. Всё остальное в целевом
 * репозитории (лендинг, CNAME, workflow) не трогается: это чужие файлы, и
 * выгрузка, которая их подчищает, однажды подчистит нужное.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BLOB_MIMES, BLOB_PREFIX } from '@shared/publish'
import { blobHref, renderCourse, renderRedirect, renderStep, renderWithdrawn } from './render.js'
import {
  formerSlugs,
  listCourses,
  listPublications,
  readBlob,
  readStep,
  stepHeadings,
  type Publication,
} from './store.js'
/*
 * Курс, каким его видят снаружи, собирается в одном месте — и зовётся отсюда, а
 * не переписывается заново. Пока копий было две, сервер и сайт показывали
 * РАЗНЫЕ курсы: выгрузка брала живое имя комнаты, маршрут оставлял записанное
 * вместе с устаревшей ссылкой на чтение. Направление импорта непривычное —
 * обычно маршруты зовут публикацию, а не наоборот, — но модуль там ни одного
 * маршрута не тянет: только `db.js` и `publish/store.js`, а вторая копия
 * правила стоит дороже направления стрелки.
 */
import { courseOfPublication, publicCourseView } from '../routes/course-view.js'
import { notebookFrom } from './notebook.js'

export interface ExportReport {
  courses: { handle: string; name: string; rows: number }[]
  seminars: { handle: string; title: string; steps: number; blobs: number }[]
  /** Страницы, на месте которых лежит надгробие: их сняли, а адрес остался. */
  withdrawn: { handle: string; title: string }[]
  root: string
}

/** Адрес, по которому это будет лежать: имя, если его дали, иначе id. */
const handleOf = (thing: { id: string; slug: string | null }): string => thing.slug ?? thing.id

function write(file: string, body: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}

/**
 * Выгрузить всё опубликованное.
 *
 * `base` — адрес сайта, он нужен для ссылок между курсом и семинаром: на Pages
 * они лежат в одном домене, но на разной глубине, и относительные пути между
 * ними читаются хуже, чем один явный корень.
 */
export function exportSite(root: string, base: string): ExportReport {
  const report: ExportReport = { courses: [], seminars: [], withdrawn: [], root }

  /*
   * Свои подкаталоги стираются целиком перед записью: снятая публикация должна
   * исчезнуть со страницы, а не остаться лежать файлом, на который никто не
   * ссылается, но который открывается по прямой ссылке.
   */
  for (const dir of ['c', 'p']) {
    rmSync(path.join(root, dir), { recursive: true, force: true })
  }

  const courses = listCourses()
  for (const course of courses) {
    // Имена комнат, ссылки на чтение и надгробия спрашиваются заново — тем же
    // кодом, которым отвечает живой сервер (routes/course-view.ts).
    const view = publicCourseView(course)
    const handle = handleOf(course)
    write(path.join(root, 'c', handle, 'index.html'), renderCourse(view, base))
    /*
     * Адрес по идентификатору обещан буквами (store.ts): ссылку, розданную до
     * того, как курсу дали имя, ломать нельзя. На живом сервере это делает
     * `WHERE id = ? OR slug = ?`, а на Pages маршрутизации нет — значит файл.
     * Прежние имена — тот же долг: курс переименовали, а ссылка со старым
     * именем уже у класса.
     */
    for (const was of [course.id, ...formerSlugs('course', course.id)]) {
      if (was === handle) continue
      write(
        path.join(root, 'c', was, 'index.html'),
        renderRedirect(`${base}/c/${handle}/`, course.name),
      )
    }
    report.courses.push({ handle, name: course.name, rows: view.items.length })
  }

  /**
   * Курс, в котором состоит семинар, — для пути наверх со страницы шага.
   *
   * Список курсов уже на руках, и он передаётся: выгрузка идёт одним проходом,
   * а без него тот же поиск шёл бы через индекс с временем жизни, заново читая
   * базу (routes/course-view.ts · courseOfPublication).
   */
  const courseOf = (pub: Publication): { name: string; handle: string } | null => {
    const found = courseOfPublication(pub, courses)
    return found ? { name: found.name, handle: handleOf(found) } : null
  }

  /*
   * Все страницы разом, а не только те, что нашлись в курсах: публикация —
   * самостоятельный предмет, и ссылку на неё могли дать до того, как завели
   * курс. Отдельный обход курсов, который здесь стоял, собирал ровно то же
   * подмножество, что и этот список, двумя строками выше него.
   */
  for (const pub of listPublications()) {
    const handle = handleOf(pub)
    const dir = path.join(root, 'p', handle)
    /** Адреса, по которым эту страницу уже давали: идентификатор и прежние имена. */
    const also = [pub.id, ...formerSlugs('publication', pub.id)].filter((a) => a !== handle)

    /*
     * Снятая страница — надгробие, а не отсутствие файла.
     *
     * Обещание записано в store.ts: снятие адрес не отменяет, ссылка обязана
     * сказать «её сняли». Живой сервер так и отвечает, а здесь каталог просто
     * стирался — и та же ссылка на Pages давала стандартный 404 GitHub, по
     * которому студент не отличает снятую страницу от опечатки в адресе.
     * Шагов и картинок в надгробии нет: читать снятое в обход решения
     * преподавателя нельзя.
     */
    if (pub.state !== 'published') {
      const stone = renderWithdrawn(pub.title, courseOf(pub), base)
      write(path.join(dir, 'index.html'), stone)
      for (const was of also) write(path.join(root, 'p', was, 'index.html'), stone)
      report.withdrawn.push({ handle, title: pub.title })
      continue
    }

    const headings = stepHeadings(pub.id)
    if (headings.length === 0) continue
    /*
     * Шаги читаются ОДИН раз на всю выгрузку. `page` — это все текстовые выводы
     * шага целиком: лог обучения, трейсбеки, таблицы; при сорока шагах по
     * мегабайту три прохода (страницы, картинки, тетрадь) стоили лишних
     * восьмидесяти мегабайт JSON.parse на каждую выкладку.
     */
    const steps = headings.map((heading) => readStep(pub.id, heading.seq))

    steps.forEach((step, index) => {
      if (!step) return
      const heading = headings[index]
      const html = renderStep({
        title: pub.title,
        publishedAt: pub.publishedAt,
        course: courseOf(pub),
        steps: headings,
        step,
        // Первый шаг — корень публикации, остальные лежат на шаг глубже.
        depth: index === 0 ? 1 : 2,
        base,
      })
      write(
        index === 0
          ? path.join(dir, 'index.html')
          : path.join(dir, String(heading.seq), 'index.html'),
        html,
      )
      /*
       * Тетрадь шага — рядом с его страницей, и ссылка на странице ведёт
       * именно в неё (render.ts). Пока файл был один на публикацию, страница
       * шага 2 из 5 отдавала состояние шага 5 и молчала об этом: в комнате это
       * уже чинил `?step=`, а здесь маршрутов нет — значит, файл.
       *
       * Первый шаг тоже пишется в каталог, хотя страница у него в корне:
       * корневой `notebook.ipynb` занят последним шагом, на него скопированы
       * розданные раньше ссылки. Без выводов тетрадь весит килобайты, так что
       * копия на шаг ничего не стоит.
       */
      write(path.join(dir, String(heading.seq), 'notebook.ipynb'), notebookFrom(step.cells))
      // Тот же долг, что и у курса: и идентификатор, и прежнее имя переживают новое.
      for (const was of also) {
        const to = index === 0 ? `${base}/p/${handle}/` : `${base}/p/${handle}/${heading.seq}/`
        write(
          index === 0
            ? path.join(root, 'p', was, 'index.html')
            : path.join(root, 'p', was, String(heading.seq), 'index.html'),
          renderRedirect(to, pub.title),
        )
      }
    })

    /*
     * Картинки — один раз на публикацию, по хэшу: он же и есть их версия.
     *
     * Под прежними адресами их нет, и это решение, а не забывчивость: там
     * лежит страница-указатель (`renderRedirect`), а в ней нет ни одного
     * `<img>` — читателя перекладывает на нынешний адрес, где картинки уже
     * свежие. Копия стоила бы сотни килобайт на публикацию × число прежних
     * имён, и стояла бы ради ссылки, которую никто не раздаёт: адрес картинки
     * студент видит, только вытащив его из разметки. Тетрадь ниже — другой
     * случай, и потому дублируется: её адрес открывают напрямую, ссылкой из
     * чата, минуя страницу целиком.
     */
    let blobs = 0
    for (const step of steps) {
      for (const cell of step?.cells ?? []) {
        /*
         * Картинки ЗАМЕТОК — такие же записи, и в каталог они обязаны попасть.
         *
         * Ссылку на них страница несёт не в наборе вывода, а прямо в тексте
         * (`![схема](blob:<хэш>.<ext>)`, см. publish/build.ts · projectNote);
         * обход, смотревший только `cell.outputs`, выгружал страницу с
         * условиями задач, которых на ней нет.
         */
        if (cell.type === 'markdown') {
          for (const found of cell.source.matchAll(/blob:([0-9a-f]{8,64})\.([a-z0-9]+)/gi)) {
            const blob = readBlob(pub.id, found[1])
            if (!blob) continue
            write(path.join(dir, `blob/${found[1]}.${found[2]}`), blob.body)
            blobs += 1
          }
        }
        for (const output of cell.outputs) {
          if (output.kind !== 'data') continue
          for (const [mime, value] of Object.entries(output.data)) {
            if (!value.startsWith(BLOB_PREFIX)) continue
            /*
             * Только то, что выгруженная страница умеет показать, — картинки.
             *
             * Фигура plotly в записях тоже лежит (её рисует читалка живого
             * инстанса), но статический каталог рисует на её месте заглушку:
             * рамки там нет, потому что нет и сервера, который отдал бы её с
             * нужным заголовком. Выгружать ради заглушки мегабайт JSON — это
             * мегабайт, который никто никогда не запросит.
             */
            if (!BLOB_MIMES.has(mime)) continue
            const blob = readBlob(pub.id, value.slice(BLOB_PREFIX.length))
            if (!blob) continue
            write(path.join(dir, blobHref(value, mime)), blob.body)
            blobs += 1
          }
        }
      }
    }

    /*
     * Тетрадь публикации — последний шаг, и под прежними адресами тоже.
     * Страница-указатель перекладывает только HTML, а «Скачать тетрадь»
     * студент копирует ссылкой: после переименования публикации она вела в
     * 404, хотя сама страница по тому же старому адресу открывалась. Страницы
     * шагов ссылаются каждая на свою тетрадь выше; этот адрес остаётся ради
     * ссылок, розданных до того, как тетради развели по шагам.
     */
    const notebook = notebookFrom(steps.at(-1)?.cells ?? [])
    write(path.join(dir, 'notebook.ipynb'), notebook)
    for (const was of also) write(path.join(root, 'p', was, 'notebook.ipynb'), notebook)

    report.seminars.push({
      handle,
      title: pub.title,
      steps: headings.length,
      blobs,
    })
  }

  return report
}
