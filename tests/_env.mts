/**
 * Every server module reaches config on import, and config resolves DATA_DIR and
 * WORKSPACE_DIR at module scope. Import this FIRST in any test that touches
 * server code, or the suite writes SQLite into the developer's real data
 * directory — which is how a test run once ate a working instance.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-test-'))

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'test-secret-not-random-on-purpose'
process.env.PUBLIC_URL = 'http://localhost:9999'
process.env.ADMIN_EMAIL = 'owner@test.local'
/*
 * Ядра у тестов нет — и не должно быть.
 *
 * Без этой строки JUPYTER_URL оставался умолчанием, localhost:8888, то есть
 * настоящим контейнером на машине разработчика. Тест, случайно потянувшийся к
 * ядру, был зелёным ровно пока рядом что-то работало, и падал шестьюдесятью
 * секундами таймаута, когда переставало. Один такой уже написался.
 *
 * Порт, на котором заведомо никого нет: обращение к ядру мимо подделки теперь
 * отказывает сразу и громко. `kernel.test.mts` поднимает свою подделку и
 * переписывает эту переменную на неё.
 */
process.env.JUPYTER_URL = 'http://127.0.0.1:1'

export const TEST_ROOT = root
