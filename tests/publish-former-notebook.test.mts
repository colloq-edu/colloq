/**
 * Прежний адрес публикации: страница переезжает, тетрадь остаётся на месте.
 *
 * Страницу под старым именем перекладывает файл-указатель, и по ней читатель
 * доезжает куда надо. С «Скачать тетрадь» так не выходит: этот адрес студент
 * копирует ссылкой и открывает напрямую — браузер скачивает файл, а не
 * показывает страницу, — и после переименования публикации ссылка из чата
 * группы отвечала 404, хотя сама страница по тому же старому адресу
 * открывалась. Поэтому `notebook.ipynb` пишется и под каждым прежним адресом.
 *
 * Второе утверждение здесь — про то, чего НЕ дублируется. Картинки под старым
 * адресом не лежат осознанно: указатель их не показывает (в нём нет ни одного
 * `<img>`), а копия стоила бы сотни килобайт × число прежних имён. Тест держит
 * обе половины решения рядом, чтобы следующий читатель видел не пропуск, а
 * выбор — и, передумав, снимал утверждение вместе с доводом.
 */
import './_env.mts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { exportSite } from '../server/src/publish/export.js'
import { formerSlugs, setPublicationSlug, writePublication } from '../server/src/publish/store.js'
import { BLOB_PREFIX } from '../shared/publish.js'
import type { PublicCell } from '../shared/publish.js'

const cell = (id: string, source: string, outputs: PublicCell['outputs'] = []): PublicCell => ({
  id,
  type: 'code',
  source,
  outputs,
  execCount: 1,
  ranMs: null,
})

/** Каталог выгрузки, который уберут за собой. */
function exported(t: { after(fn: () => void): void }): {
  at: (...parts: string[]) => string
  read: (...parts: string[]) => string
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  exportSite(root, 'https://colloq.ru')
  const at = (...parts: string[]): string => path.join(root, ...parts)
  return { at, read: (...parts: string[]) => fs.readFileSync(at(...parts), 'utf8') }
}

test('тетрадь скачивается по каждому адресу, который публикация носила', (t) => {
  const id = 'pub-former-notebook'
  createSession(id, 'Переезд тетради', null)
  const pub = writePublication({
    sessionId: id,
    title: 'Переезд тетради',
    by: 'Ада',
    steps: [
      { seq: 2, label: 'перед упражнением', at: 1, cells: [cell('c1', 'before = 1')] },
      { seq: 0, label: 'сейчас', at: 2, cells: [cell('c2', 'after = 2')] },
    ],
    blobs: [],
  })
  // Два переименования подряд: прежних имён у публикации бывает больше одного.
  assert.equal(setPublicationSlug(pub.id, 'nedelya-02'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-03'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-04'), 'ok')
  assert.deepEqual(formerSlugs('publication', pub.id), ['nedelya-02', 'nedelya-03'])

  const { at, read } = exported(t)
  const code = (...parts: string[]): string =>
    (JSON.parse(read(...parts)) as { cells: { source: string[] }[] }).cells
      .map((c) => c.source.join(''))
      .join('\n')

  // Нынешний адрес: корневая тетрадь — последний шаг, как и была.
  assert.equal(code('p', 'nedelya-04', 'notebook.ipynb'), 'after = 2')
  // И тот же файл под каждым адресом, по которому эту страницу уже давали.
  for (const was of ['nedelya-02', 'nedelya-03', pub.id]) {
    assert.ok(
      fs.existsSync(at('p', was, 'notebook.ipynb')),
      `«Скачать тетрадь» с адреса «${was}» ведёт в 404 — ` +
        'а ссылку скопировали до переименования',
    )
    assert.equal(code('p', was, 'notebook.ipynb'), 'after = 2')
    // Страница по тому же адресу — указатель, а не копия: расходиться им нельзя.
    assert.match(read('p', was, 'index.html'), /https:\/\/colloq\.ru\/p\/nedelya-04\//)
  }
})

test('картинок под прежним адресом нет — и это решение, а не пропуск', (t) => {
  const id = 'pub-former-blob'
  createSession(id, 'Переезд с картинкой', null)
  const hash = 'f'.repeat(32)
  const pub = writePublication({
    sessionId: id,
    title: 'Переезд с картинкой',
    by: 'Ада',
    steps: [
      {
        seq: 0,
        label: 'сейчас',
        at: 1,
        cells: [
          cell('c1', 'plt.show()', [
            { kind: 'data', data: { 'image/png': `${BLOB_PREFIX}${hash}` }, execCount: 1 },
          ]),
        ],
      },
    ],
    blobs: [{ hash, mime: 'image/png', body: Buffer.from('картинка на сотни килобайт') }],
  })
  assert.equal(setPublicationSlug(pub.id, 'grafik-01'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'grafik-02'), 'ok')

  const { at, read } = exported(t)
  // Под нынешним адресом картинка лежит и страница на неё ссылается.
  assert.ok(fs.existsSync(at('p', 'grafik-02', 'blob', `${hash}.png`)), 'картинки нет у страницы')
  assert.match(read('p', 'grafik-02', 'index.html'), new RegExp(`blob/${hash}\\.png`))

  const pointer = read('p', 'grafik-01', 'index.html')
  /*
   * Довод, на котором держится решение: указатель ничего не рисует. Пока это
   * так, копия картинок под старым адресом — байты, которые никто не запросит;
   * начнёт рисовать — утверждение упадёт раньше, чем страница поедет пустыми
   * рамками у класса.
   */
  assert.ok(!pointer.includes('<img'), 'указатель начал рисовать картинки — ему нужны свои')
  assert.match(pointer, /https:\/\/colloq\.ru\/p\/grafik-02\//)
  assert.equal(
    fs.existsSync(at('p', 'grafik-01', 'blob')),
    false,
    'картинки скопированы под прежний адрес: их там некому показывать, ' +
      'а весят они сотни килобайт на каждое прежнее имя',
  )
  // А тетрадь — наоборот: её адрес открывают напрямую, и она обязана быть.
  assert.ok(fs.existsSync(at('p', 'grafik-01', 'notebook.ipynb')))
})
