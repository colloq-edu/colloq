/**
 * Версия, которую сервер называет о себе: `/api/health` и журнал старта.
 *
 * Число — из КОРНЕВОГО package.json, того же, из которого его берут колесо,
 * веб (vite define) и теги выпуска: другого источника у версии нет, и копии в
 * package.json воркспейсов лишь сверяются с ним (scripts/version.mts check).
 *
 * Импорт JSON, а не чтение файла на старте. esbuild встраивает объект в бандл
 * на сборке, поэтому собранный server.js знает свою версию, где бы он ни
 * лежал: в образе рядом с ним нет корневого package.json (Dockerfile кладёт
 * туда серверный), а в колесе — свой, от pack.mts. Под tsx (make dev, тесты)
 * тот же импорт читает файл из дерева.
 */
import rootPackage from '../../package.json' with { type: 'json' }

export const COLLOQ_VERSION: string = rootPackage.version
