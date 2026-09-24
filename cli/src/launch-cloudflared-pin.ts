/**
 * Which cloudflared colloq downloads on its own: the version and checksums.
 *
 * Only one file from the internet that then runs on the teacher's computer is
 * acceptable: exactly the one whose bytes somebody has already checked. So
 * this is not "the latest release" but one named release, and every file has
 * its own sha256: `latest` would mean that every teacher runs something nobody
 * has seen, and an answer swapped on the way would not give itself away in any
 * way.
 *
 * There are four files, exactly the systems the pip wheel is built for
 * (python/pyproject.toml · classifiers: macOS and Linux). For macOS the
 * release ships a .tgz archive with one file inside, for Linux a bare
 * executable. That is why a record has two sums: sha256 is of the downloaded
 * file (checked before unpacking), binarySha256 is of what will become the
 * executable; for Linux they coincide. The second one is needed also because
 * our own copy in <home>/bin is checked on every start: this way both a
 * swapped file and a copy from an earlier colloq version are recognized the
 * same way, and downloaded again.
 *
 * The sums were obtained on 18 Sep 2026: the four files were downloaded with
 * curl from GitHub, hashed with `shasum -a 256`, the archives unpacked and
 * hashed once more; all four file sums matched the digest field in the
 * release API.
 *
 * How to bump the version:
 *   1. pick a release: https://github.com/cloudflare/cloudflared/releases;
 *   2. download the four files from the table below:
 *        v=2026.9.1
 *        for a in cloudflared-darwin-arm64.tgz cloudflared-darwin-amd64.tgz \
 *                 cloudflared-linux-amd64 cloudflared-linux-arm64; do
 *          curl -fsSLO "https://github.com/cloudflare/cloudflared/releases/download/$v/$a"
 *        done
 *   3. shasum -a 256 * → sha256; ls -l → size; for .tgz also
 *      `tar -xzf <archive> && shasum -a 256 cloudflared` → binarySha256;
 *   4. check against GitHub: gh api repos/cloudflare/cloudflared/releases/tags/$v
 *      --jq '.assets[] | [.name, .digest] | @tsv';
 *   5. update CLOUDFLARED_VERSION and the table, run
 *      tests/cli-cloudflared.test.mts and `colloq start --share` on a live machine.
 *
 * The file name starts with launch: the test rig tests/local-launch-process.test.mts
 * copies into itself exactly cli/src/launch*.ts, and a module with another
 * name would not be found there.
 */
export const CLOUDFLARED_VERSION = '2026.9.1'

export interface CloudflaredAsset {
  /** The process.platform the file is built for. */
  platform: 'darwin' | 'linux'
  /** The process.arch the file is built for. */
  arch: 'arm64' | 'x64'
  /** The file name in the GitHub release. */
  name: string
  /** tgz is an archive with one cloudflared file inside; binary is the executable itself. */
  archive: 'tgz' | 'binary'
  /** The size of the downloaded file in bytes: we read no more than that. */
  size: number
  /** sha256 of the downloaded file. */
  sha256: string
  /** sha256 of the executable (after unpacking). */
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
