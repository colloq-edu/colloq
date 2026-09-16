/**
 * Правила раздачи статики живут в трёх файлах, и все три — не код, а сценарии.
 *
 * Makefile решает, будет ли сборка сжата заранее; scripts/host.sh — скажет ли
 * кто-нибудь вслух, что она не сжата, и уедет ли она на ретранслятор;
 * scripts/relay-setup.sh — станет ли ретранслятор её раздавать. Проверить их
 * запуском нельзя: один собирает фронтенд, второй открывает туннель, третий
 * ставит службы на чужую машину. Поэтому здесь закреплены сами решения — те,
 * которые уже были потеряны однажды.
 *
 * Потеряны они были так: сжатие включалось флагом `OPTIMIZE=1`, флаг надо было
 * вспомнить, и его не вспоминали. В аудиторию уезжала сборка без единого .br,
 * и сервер сжимал каждый файл на каждый запрос — 219 751 байт вместо 194 920 и
 * 11.6 мс процессорного времени на каждого студента.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name: string) => fs.readFileSync(path.join(repo, name), 'utf8')
const makefile = read('Makefile')
const host = read('scripts/host.sh')
const relay = read('scripts/relay-setup.sh')
const load = read('scripts/load.mts')

/** Строки без комментариев: про эти решения они как раз и рассказывают. */
const code = (text: string, mark = '#') =>
  text
    .split('\n')
    .filter((line) => !new RegExp(`^\\s*(@#|${mark})`).test(line))
    .join('\n')

test('сборка сжимается заранее по умолчанию, а не по вспомненному флагу', () => {
  assert.match(
    code(makefile),
    /npm run \$\(if \$\(filter 1,\$\(FAST\)\),build,build:optimized\)/,
    'make run снова собирает без предварительного сжатия',
  )
  assert.equal(
    /OPTIMIZE/.test(code(makefile)),
    false,
    'сжатие снова прячется за флагом, который надо вспомнить',
  )
})

test('make host считает несжатые файлы и говорит о них до ссылки', () => {
  const lines = code(host).split('\n')
  const counted = lines.findIndex((line) => /UNCOMPRESSED="\$\(assets_uncompressed\)"/.test(line))
  const opened = lines.findIndex((line) => /^if \[ "\$VIA" = direct \]; then$/.test(line))
  assert.ok(counted > 0, 'проверки про .br в host.sh больше нет')
  assert.ok(counted < opened, 'про несжатую сборку говорят уже после того, как открыли адрес')
  assert.match(host, /npm run build:optimized/)
})

test('несжатым считается только то, что действительно должно быть сжато', () => {
  // Порог в килобайт — тот же, что у web/scripts/precompress.mjs: на меньшем
  // .br не бывает по замыслу, и ругаться на него значило бы ругаться всегда.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-dist-'))
  const assets = path.join(fake, 'web/dist/assets')
  fs.mkdirSync(assets, { recursive: true })
  const счёт = (): string => {
    const run = spawnSync(
      'bash',
      ['-c', `${/^assets_uncompressed\(\) \{$[\s\S]*?^\}$/m.exec(host)![0]}\nassets_uncompressed`],
      {
        cwd: fake,
        encoding: 'utf8',
      },
    )
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.trim()
  }
  assert.equal(счёт(), '0', 'пустая сборка — не повод ругаться')
  fs.writeFileSync(path.join(assets, 'tiny-a.js'), 'x'.repeat(500))
  assert.equal(счёт(), '0', 'ругань на файл, который не сжимают по замыслу')
  fs.writeFileSync(path.join(assets, 'big-b.js'), 'x'.repeat(4000))
  assert.equal(счёт(), '1')
  fs.writeFileSync(path.join(assets, 'big-b.js.br'), 'сжато')
  assert.equal(счёт(), '0')
  fs.rmSync(fake, { recursive: true, force: true })
})

test('статика уезжает на ретранслятор после туннеля, и отказ — не смерть', () => {
  const lines = code(host).split('\n')
  const proxied = lines.findIndex((line) => /no answer from the relay/.test(line))
  const uploaded = lines.findIndex((line) => /^\s*upload_assets$/.test(line))
  assert.ok(uploaded > proxied && proxied > 0, 'зеркало наполняется не после подтверждения туннеля')
  const body = /^upload_assets\(\) \{$[\s\S]*?^\}$/m.exec(host)![0]
  assert.match(body, /--upload-file/)
  assert.match(body, /Authorization: Bearer \$\{RELAY_TOKEN\}/)
  assert.equal(/\bdie\b/.test(body), false, 'неудачная выкладка зеркала роняет make host')
})

test('туннель держит запас соединений и не сжимает сжатое', () => {
  assert.match(host, /transport\.poolCount = 5/)
  assert.match(relay, /transport\.maxPoolCount = 10/)
  // useCompression через туннель, по которому едет уже сжатое, — это плата
  // процессором за отрицательный выигрыш. Решение записано, а не забыто.
  assert.equal(/useCompression\s*=\s*true/.test(host), false)
  assert.match(host, /useCompression здесь НЕ включается/)
})

test('ретранслятор раздаёт зеркало сам, а промах уходит в туннель', () => {
  // Матчер `file`, а не file_server с pass_thru: пустое или устаревшее
  // зеркало не должно ни отвечать, ни ставить заголовки.
  assert.match(
    relay,
    /@mirror \{[\s\S]*?host \*\.\$\{DOMAIN\}[\s\S]*?path \/assets\/\* \/fonts\/\* \/pdf\/\*[\s\S]*?file \{[\s\S]*?try_files \{path\}/,
  )
  assert.match(relay, /handle @mirror \{[\s\S]*?precompressed br gzip/)
  assert.match(relay, /header \/assets\/\* Cache-Control "public, max-age=31536000, immutable"/)
  // Шрифт под тем же именем меняют руками: год на него — это год, когда
  // замену не увидит никто из вернувшихся (тот же довод, что в server/src/app.ts).
  assert.match(relay, /header \/fonts\/\* Cache-Control "public, max-age=3600"/)
  assert.match(relay, /header \/pdf\/\* Cache-Control "public, max-age=3600"/)
  assert.equal(
    /header \/(fonts|pdf)\/\* Cache-Control "[^"]*immutable/.test(relay),
    false,
    'шрифты и pdf снова ушли с immutable на год',
  )
  assert.match(relay, /handle \/\.relay\/assets\/\*/)
  assert.match(relay, /reverse_proxy 127\.0\.0\.1:9182/)
  // Зеркало пишет один пользователь, читает другой; без setgid caddy получил
  // бы 403 на каждый файл, то есть зеркало не заработало бы вовсе.
  assert.match(relay, /install -d -o assets -g caddy -m 2750 \/var\/lib\/colloq-assets/)
  assert.match(relay, /systemctl enable --now frps caddy colloq-capy colloq-assets/)
  assert.match(relay, /colloq-assets-prune\.timer/)
})

test('демонам ретранслятора есть чем дышать: подкачка, потолки, дескрипторы', () => {
  // Измерено на живой паре: ядро тридцать шесть раз убивало то frps, то
  // caddy, и каждое убийство рвало ВСЕ туннели разом.
  assert.match(relay, /mkswap \/swapfile/)
  assert.match(relay, /swapon \/swapfile/)
  assert.match(relay, /^MemoryHigh=1536M$/m)
  assert.match(relay, /^MemoryHigh=1024M$/m)
  assert.equal(
    (relay.match(/^LimitNOFILE=65535$/gm) ?? []).length,
    2,
    'дескрипторы подняты не обоим демонам',
  )
})

test('нагрузочный стенд не повторяет серверу то, чего вкладки больше не шлют', () => {
  // Вкладка перестала возвращать чужое присутствие (web/src/lib/presence.ts ·
  // ownChanges), а стенд продолжал — и завышал холостой процессор в 2.7 раза.
  assert.match(load, /const ECHO = process\.env\.LOAD_ECHO === '1'/)
  assert.match(makefile, /LOAD_ECHO=1 make load/)
})
