/**
 * Какой cloudflared colloq скачивает сам: версия и контрольные суммы.
 *
 * Файл из интернета, который потом запускается на компьютере преподавателя,
 * допустим только один — ровно тот, чьи байты кто-то уже сверил. Поэтому
 * здесь не «последний выпуск», а один названный, и у каждого файла свой
 * sha256: `latest` означал бы, что у каждого преподавателя запускается то,
 * чего никто не видел, а подменённый ответ по дороге ничем бы себя не выдал.
 *
 * Файлов четыре — ровно те системы, для которых собирается колесо pip
 * (python/pyproject.toml · classifiers: macOS и Linux). Для macOS выпуск
 * кладёт архив .tgz с одним файлом внутри, для Linux — голый исполняемый
 * файл. Поэтому сумм у записи две: sha256 — скачанного файла (сверяется до
 * распаковки), binarySha256 — того, что станет исполняемым; у Linux они
 * совпадают. Вторая нужна ещё и потому, что своя копия в <home>/bin
 * сверяется при каждом запуске: так и подменённый файл, и копия от прежней
 * версии colloq узнаются одинаково — и скачиваются заново.
 *
 * Суммы получены 18.09.2026: четыре файла скачаны curl-ом с GitHub, посчитаны
 * `shasum -a 256`, архивы распакованы и посчитаны ещё раз; все четыре суммы
 * файлов совпали с полем digest в API выпуска.
 *
 * Как поднять версию:
 *   1. выбрать выпуск: https://github.com/cloudflare/cloudflared/releases;
 *   2. скачать четыре файла из таблицы ниже:
 *        v=2026.9.1
 *        for a in cloudflared-darwin-arm64.tgz cloudflared-darwin-amd64.tgz \
 *                 cloudflared-linux-amd64 cloudflared-linux-arm64; do
 *          curl -fsSLO "https://github.com/cloudflare/cloudflared/releases/download/$v/$a"
 *        done
 *   3. shasum -a 256 * → sha256; ls -l → size; для .tgz ещё
 *      `tar -xzf <архив> && shasum -a 256 cloudflared` → binarySha256;
 *   4. сверить с GitHub: gh api repos/cloudflare/cloudflared/releases/tags/$v
 *      --jq '.assets[] | [.name, .digest] | @tsv';
 *   5. поправить CLOUDFLARED_VERSION и таблицу, прогнать
 *      tests/cli-cloudflared.test.mts и `colloq start --share` на живой машине.
 *
 * Имя файла начинается с launch: стенд tests/local-launch-process.test.mts
 * копирует в себя ровно cli/src/launch*.ts, и модуль с другим именем там не
 * нашёлся бы.
 */
export const CLOUDFLARED_VERSION = '2026.9.1'

export interface CloudflaredAsset {
  /** process.platform, для которого файл собран. */
  platform: 'darwin' | 'linux'
  /** process.arch, для которого файл собран. */
  arch: 'arm64' | 'x64'
  /** Имя файла в выпуске на GitHub. */
  name: string
  /** tgz — архив с одним файлом cloudflared внутри; binary — сам исполняемый файл. */
  archive: 'tgz' | 'binary'
  /** Размер скачанного файла в байтах: больше не читаем. */
  size: number
  /** sha256 скачанного файла. */
  sha256: string
  /** sha256 исполняемого файла (после распаковки). */
  binarySha256: string
}

export const CLOUDFLARED_ASSETS: readonly CloudflaredAsset[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    name: 'cloudflared-darwin-arm64.tgz',
    archive: 'tgz',
    size: 19217478,
    sha256: 'c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe',
    binarySha256: '9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e',
  },
  {
    platform: 'darwin',
    arch: 'x64',
    name: 'cloudflared-darwin-amd64.tgz',
    archive: 'tgz',
    size: 21118723,
    sha256: 'ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4',
    binarySha256: '1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75',
  },
  {
    platform: 'linux',
    arch: 'x64',
    name: 'cloudflared-linux-amd64',
    archive: 'binary',
    size: 39838488,
    sha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc',
    binarySha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    name: 'cloudflared-linux-arm64',
    archive: 'binary',
    size: 37466252,
    sha256: '3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3',
    binarySha256: '3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3',
  },
]
