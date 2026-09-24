/**
 * Exporting publications to a static site.
 *
 * A directory per course and a directory per step, each with a plain
 * `index.html`. No API, no routing, no scripts: a page a student opens on
 * Wednesday evening must not depend on whether the teacher's laptop is on.
 *
 * Only our own subdirectories are written, `c/` and `p/`. Everything else in
 * the target repository (the landing page, CNAME, workflows) is left alone:
 * those are someone else's files, and an export that cleans them up will one
 * day clean up something needed.
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
 * The course as the outside world sees it is assembled in one place, and is
 * called from here rather than rewritten. While there were two copies, the
 * server and the site showed DIFFERENT courses: the export took the room's
 * live name, while the route kept the recorded one together with a stale read
 * link. The import direction is unusual (routes usually call the publication,
 * not the other way round), but that module pulls in no route: only `db.js`
 * and `publish/store.js`, and a second copy of the rule costs more than the
 * direction of the arrow.
 */
import { courseOfPublication, publicCourseView } from '../routes/course-view.js'
import { notebookFrom } from './notebook.js'

export interface ExportReport {
  courses: { handle: string; name: string; rows: number }[]
  seminars: { handle: string; title: string; steps: number; blobs: number }[]
  /** Pages replaced by a tombstone: they were withdrawn, but the address stayed. */
  withdrawn: { handle: string; title: string }[]
  root: string
}

/** The address this will live at: the name if one was given, otherwise the id. */
const handleOf = (thing: { id: string; slug: string | null }): string => thing.slug ?? thing.id

function write(file: string, body: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}

/**
 * Export everything published.
 *
 * `base` is the site's address, needed for links between a course and a
 * seminar: on Pages they live in one domain but at different depths, and
 * relative paths between them read worse than one explicit root.
 */
export function exportSite(root: string, base: string): ExportReport {
  const report: ExportReport = { courses: [], seminars: [], withdrawn: [], root }

  /*
   * Our own subdirectories are wiped entirely before writing: a withdrawn
   * publication must disappear from the page, not stay behind as a file that
   * nothing links to but that opens by a direct link.
   */
  for (const dir of ['c', 'p']) {
    rmSync(path.join(root, dir), { recursive: true, force: true })
  }

  const courses = listCourses()
  for (const course of courses) {
    // Room names, read links and tombstones are asked for afresh, by the same
    // code the live server answers with (routes/course-view.ts).
    const view = publicCourseView(course)
    const handle = handleOf(course)
    write(path.join(root, 'c', handle, 'index.html'), renderCourse(view, base))
    /*
     * The address by id is promised in writing (store.ts): a link handed out
     * before the course got a name must not break. On the live server
     * `WHERE id = ? OR slug = ?` does it, and Pages has no routing, so it is a
     * file. Former names are the same debt: the course was renamed, and the
     * class already has the link with the old name.
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
   * The course the seminar belongs to, for the way up from a step page.
   *
   * The course list is already at hand, and it is passed on: the export runs
   * in one pass, and without it the same lookup would go through an index
   * with a time to live, reading the database again
   * (routes/course-view.ts · courseOfPublication).
   */
  const courseOf = (pub: Publication): { name: string; handle: string } | null => {
    const found = courseOfPublication(pub, courses)
    return found ? { name: found.name, handle: handleOf(found) } : null
  }

  /*
   * All pages at once, not only those found in courses: a publication is an
   * object of its own, and a link to it may have been given before the course
   * was created. The separate walk over courses that used to stand here
   * collected exactly the same subset as this list, two lines above it.
   */
  for (const pub of listPublications()) {
    const handle = handleOf(pub)
    const dir = path.join(root, 'p', handle)
    /** Addresses this page has already been given under: the id and former names. */
    const also = [pub.id, ...formerSlugs('publication', pub.id)].filter((a) => a !== handle)

    /*
     * A withdrawn page is a tombstone, not a missing file.
     *
     * The promise is written in store.ts: withdrawal does not cancel the
     * address, and the link must say "it was withdrawn". The live server
     * answers exactly so, while here the directory was simply wiped, and the
     * same link on Pages gave GitHub's standard 404, from which a student
     * cannot tell a withdrawn page from a typo in the address. The tombstone
     * has no steps and no images: reading what was withdrawn around the
     * teacher's decision is not allowed.
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
     * Steps are read ONCE for the whole export. `page` is all of a step's text
     * outputs in full: the training log, tracebacks, tables; with forty steps
     * of a megabyte each, three passes (pages, images, notebook) cost an extra
     * eighty megabytes of JSON.parse on every deploy.
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
        // The first step is the publication's root; the others live one level deeper.
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
       * The step's notebook sits next to its page, and the link on the page
       * leads exactly to it (render.ts). While there was one file per
       * publication, the page of step 2 of 5 served the state of step 5 and
       * said nothing about it: in the room `?step=` already fixed that, and
       * here there are no routes, so it is a file.
       *
       * The first step is also written to a directory, even though its page
       * is at the root: the root `notebook.ipynb` is taken by the last step,
       * and links handed out earlier point to it. Without outputs a notebook
       * weighs kilobytes, so a copy per step costs nothing.
       */
      write(path.join(dir, String(heading.seq), 'notebook.ipynb'), notebookFrom(step.cells))
      // The same debt as for the course: both the id and the former name outlive the new one.
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
     * Images, once per publication, by hash: the hash is also their version.
     *
     * They are not under the former addresses, and that is a decision, not
     * forgetfulness: a pointer page lives there (`renderRedirect`), and it has
     * not a single `<img>`; the reader is moved to the current address, where
     * the images are fresh. A copy would cost hundreds of kilobytes per
     * publication × the number of former names, for the sake of a link nobody
     * hands out: a student sees an image's address only by pulling it out of
     * the markup. The notebook below is a different case and is therefore
     * duplicated: its address is opened directly, by a link from the chat,
     * bypassing the page entirely.
     */
    let blobs = 0
    for (const step of steps) {
      for (const cell of step?.cells ?? []) {
        /*
         * NOTE images are the same kind of record, and they must get into the
         * directory.
         *
         * The page carries the link to them not in an output bundle but right
         * in the text (`![diagram](blob:<hash>.<ext>)`, see publish/build.ts ·
         * projectNote); a walk that looked only at `cell.outputs` exported a
         * page whose problem statements were missing their images.
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
             * Only what the exported page can show: images.
             *
             * The plotly figure is in the records too (the live instance's
             * reader draws it), but the static directory draws a placeholder
             * in its place: there is no frame there, because there is no
             * server to serve it with the right header. Exporting a megabyte
             * of JSON for a placeholder is a megabyte nobody will ever request.
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
     * The publication's notebook is the last step, under the former addresses
     * too. A pointer page moves only the HTML, and a student copies "Download
     * notebook" as a link: after the publication was renamed it led to a 404,
     * even though the page itself opened at the same old address. Step pages
     * each link to their own notebook above; this address stays for links
     * handed out before notebooks were split by step.
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
