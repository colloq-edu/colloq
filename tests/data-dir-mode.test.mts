/**
 * Каталог данных закрыт для всех, кроме нас.
 *
 * Внутри лежат ключи входа преподавателей, ключ модели инстанса и токен
 * установки. Заводили каталог трое — config.ts, db.ts и admin/auth.ts, — и
 * `mode: 0o700` стоял только у одного; а `mkdirSync(mode)` на уже
 * существующем каталоге не делает ничего. Побеждал тот, кто позвал первым, и
 * это всегда config.ts (он грузится раньше db.ts): каталог выходил 0755 при
 * комментарии в db.ts, обещающем «0700, закрытый для всех». Утечки не было —
 * сами файлы 0600, — но обещание в коде должно быть правдой, иначе следующий
 * положит сюда что-то менее осторожное, поверив ему.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config, ensureDataDir } from '../server/src/config.js'
// Импорт ради побочного действия: db.ts заводит каталог при загрузке — ровно
// так же, как в живом процессе.
import '../server/src/db.js'

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777

test('каталог данных — 0700, кем бы из троих он ни был заведён', () => {
  assert.equal(modeOf(config.dataDir).toString(8), '700')
})

test('каталог, заведённый до нас чужим umask, чинится, а не остаётся 0755', () => {
  /*
   * Обычный случай: `make dirs` (или прошлая версия сервера) завёл `data/`
   * заранее, и на запуске мы приходим к готовому каталогу. Именно здесь
   * `mkdirSync(mode)` бессилен, и именно поэтому рядом стоит chmod.
   */
  fs.chmodSync(config.dataDir, 0o755)
  assert.equal(modeOf(config.dataDir).toString(8), '755', 'chmod не сработал — тесту не на чем стоять')

  ensureDataDir()

  assert.equal(modeOf(config.dataDir).toString(8), '700')
})

test('база лежит внутри него и сама закрыта', () => {
  assert.equal(modeOf(path.join(config.dataDir, 'colloq.db')).toString(8), '600')
})
