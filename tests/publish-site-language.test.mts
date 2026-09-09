/** Exercise the actual export CLI in a fresh process, without the app's locale bootstrap. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = path.resolve(import.meta.dirname, '..')

test('publish-site --dry uses persisted instance language, with UI_LANGUAGE only as fallback', t => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'colloq-export-language-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const site = path.join(fixture, 'site')
  const data = path.join(fixture, 'data')
  mkdirSync(site)
  writeFileSync(path.join(site, 'index.html'), 'landing page must remain unchanged')
  const git = spawnSync('git', ['init', '-q', fixture], { encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    DATA_DIR: data,
    WORKSPACE_DIR: path.join(fixture, 'workspace'),
    SESSION_SECRET: 'export-language-test',
    KERNEL_BACKEND: 'test',
    KERNEL_ISOLATION: 'off',
    JUPYTER_URL: 'http://127.0.0.1:1',
    UI_LANGUAGE: 'ru',
    TZ: 'UTC',
  }
  const node = (args: string[], language = 'ru') => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
      cwd: repo,
      env: { ...environment, UI_LANGUAGE: language },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  node(['--input-type=module', '--eval', `
    import { db, createSession } from './server/src/db.js'
    import { createCourse, setCourseItems, setCourseSlug, setPublicationSlug, setPublicationState, writePublication } from './server/src/publish/store.js'
    const at = Date.UTC(2026,8,9,12)
    const cell = {id:'cell',type:'code',source:'print("не переводить <tag>")',outputs:[{kind:'stream',name:'stdout',text:'Исходный вывод пользователя'}],execCount:1,ranMs:1000}
    createSession('export-language-live', 'Материал пользователя', null)
    const pub = writePublication({sessionId:'export-language-live',title:'Материал пользователя',by:null,steps:[{seq:1,label:'Шаг автора',at,cells:[cell]}],blobs:[]})
    setPublicationSlug(pub.id,'lesson-language')
    const course = createCourse('Курс автора', null, null)
    setCourseItems(course.id,course.rev,[{kind:'seminar',sessionId:'export-language-live',name:'Материал пользователя',publication:null}])
    setCourseSlug(course.id,'previous-language')
    setCourseSlug(course.id,'course-language')
    createSession('export-language-withdrawn','Снятый материал',null)
    const removed=writePublication({sessionId:'export-language-withdrawn',title:'Снятый материал',by:null,steps:[{seq:1,label:'Шаг автора',at,cells:[cell]}],blobs:[]})
    setPublicationSlug(removed.id,'withdrawn-language')
    setPublicationState(removed.id,'withdrawn')
    db.exec('CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO instance_settings (key,value) VALUES (?,?)').run('ui.language','en')
    db.close()
  `])
  const exportCli = (language: string) => node([
    'scripts/publish-site.mts', '--site', site, '--data', data,
    '--base', 'https://export.example', '--dry',
  ], language)
  const page = (relative: string) => readFileSync(path.join(site, relative, 'index.html'), 'utf8')
  exportCli('ru')
  assert.equal(page('c/course-language').includes('lang="en"'), true, 'fresh CLI must use persisted EN even when environment says RU')
  assert.match(page('p/lesson-language'), /Download notebook/)
  assert.match(page('p/withdrawn-language'), /teacher withdrew/)
  assert.match(page('c/previous-language'), /This page has moved/)
  assert.match(page('p/lesson-language'), /не переводить &lt;tag&gt;/)
  assert.match(page('p/lesson-language'), /Исходный вывод пользователя/)
  assert.match(page('c/course-language'), /Курс автора/)
  assert.equal(readFileSync(path.join(site,'index.html'),'utf8'),'landing page must remain unchanged')
  assert.equal(spawnSync('git',['-C',fixture,'diff','--cached','--name-only'],{encoding:'utf8'}).stdout,'','dry export must not stage files')

  node(['--input-type=module','--eval', `
    import { db } from './server/src/db.js'
    db.prepare('DELETE FROM instance_settings WHERE key=?').run('ui.language')
    db.close()
  `])
  exportCli('en')
  assert.equal(page('c/course-language').includes('lang="en"'), true, 'UI_LANGUAGE supplies the locale when no saved setting exists')
  node(['--input-type=module','--eval', `
    import { db } from './server/src/db.js'
    db.prepare('INSERT INTO instance_settings (key,value) VALUES (?,?)').run('ui.language','ru')
    db.close()
  `])
  exportCli('en')
  assert.equal(page('c/course-language').includes('lang="ru"'), true, 'regenerating after a persisted language change must update static pages')
  assert.match(page('p/lesson-language'), /Скачать тетрадь/)
  assert.match(page('p/lesson-language'), /Исходный вывод пользователя/)
})
