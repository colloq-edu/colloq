/**
 * Every server module reaches config on import, and config resolves DATA_DIR and
 * WORKSPACE_DIR at module scope. Import this FIRST in any test that touches
 * server code, or the suite writes SQLite into the developer's real data
 * directory — which is how a test run once ate a working instance.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-test-'))

/*
 * За собой прибирает сам процесс, и делает это в самом конце.
 *
 * Каталог заводится на КАЖДЫЙ файл сюиты — своя SQLite, своя папка комнат, — и
 * не убирался никогда: `npm test` оставлял девяносто шесть штук за прогон, а
 * books/control-room/paths/tree-move пишут в свой по паре тысяч файлов. На
 * машине, где эту сюиту гоняют месяцами, набралось семнадцать тысяч каталогов
 * и пять с половиной гигабайт — и ни строки в выводе о том, откуда они.
 *
 * Именно `exit`, а не `after()` из node:test: сюда доходят и упавший файл, и
 * брошенное исключение, и — проверено — дочерний процесс под
 * `--test-force-exit`, который сам по себе выходить не собирался. К этому
 * моменту не работает уже ничто, так что снос папки не может вырвать диск
 * из-под фонового таймера, который ещё пишет снимок или проекцию тетради.
 *
 * Каталоги прошлых прогонов не трогаются: рядом может идти вторая сюита, а
 * стереть чужой DATA_DIR посреди её работы — ровно та беда, от которой всё это
 * заведено. Оставшееся от старых версий убирается руками.
 */
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

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

/*
 * И контейнеров у тестов тоже нет.
 *
 * У комнаты теперь свой контейнер (`kernel/pool.ts`), и без этой строки сюита
 * поднимала настоящий на каждый семинар: один прогон оставил на машине
 * тридцать шесть висящих `colloq-room-*`. Подделка Jupyter в `kernel.test.mts`
 * заменяет собой ядро целиком, так что поднимать нечего.
 */
process.env.KERNEL_ISOLATION = 'off'

export const TEST_ROOT = root
