/**
 * Куда ходит общий терминал.
 *
 * Адрес Jupyter — свойство комнаты, а не процесса: ради этого два семинара и
 * могут одновременно сидеть на разном Python. Ядро это соблюдало с самого
 * появления окружений, а терминал читал глобальную настройку — и в семинаре с
 * выбранным окружением `pip install` уходил в контейнер, которого Python этой
 * комнаты не видит. Команда отрабатывала, писала «successfully installed» и не
 * меняла ничего, что можно было бы импортировать из ячейки.
 *
 * Проверка идёт по исходнику, а не по поведению, и это осознанно: чтобы поймать
 * возврат этой ошибки в работе, нужны два живых контейнера Jupyter и
 * терминадо-сокет к каждому — то есть проверка, которой не будет в CI и которая
 * не запустится на ноутбуке без докера. А ошибка вся целиком в одной строке:
 * взяли адрес не оттуда. Такую строку видно чтением.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

test('терминал не читает адрес Jupyter из настроек инстанса', () => {
  const source = read('server/src/kernel/terminal.ts')
  const offenders = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => line.includes('config.jupyter'))

  assert.deepEqual(
    offenders,
    [],
    `терминал снова берёт адрес из config.jupyter — в комнате со своим окружением ` +
      `он уйдёт в чужой контейнер:\n` +
      offenders.map(({ no, line }) => `  terminal.ts:${no}  ${line}`).join('\n'),
  )
})

test('терминал спрашивает адрес у окружения комнаты', () => {
  const source = read('server/src/kernel/terminal.ts')
  assert.ok(
    source.includes('endpointForEnvironment(sessionEnvironment('),
    'терминал должен разрешать адрес через окружение семинара, как это делает ядро',
  )
})

test('ядро и терминал разрешают адрес одинаково', () => {
  /*
   * Две подсистемы, одно правило. Если одна из них когда-нибудь начнёт
   * вычислять адрес по-своему, разойдутся они молча: обе будут работать, просто
   * в разных контейнерах, и заметит это студент, у которого импорт не находит
   * только что поставленный пакет.
   */
  const kernel = read('server/src/kernel/index.ts')
  const terminal = read('server/src/kernel/terminal.ts')

  /*
   * Проверяется правило, а не буква.
   *
   * Раньше здесь стояло точное выражение `endpointForEnvironment(session
   * Environment(sessionId))`, и тест сломался от правки, которая ничего не
   * меняла по смыслу: имя окружения понадобилось второй раз — чтобы забыть
   * протухший адрес при отказе, — и переехало в переменную. Само правило
   * осталось тем же, а проверка его не пережила.
   */
  for (const [name, source] of [
    ['ядро', kernel],
    ['терминал', terminal],
  ] as const) {
    assert.ok(
      source.includes('endpointForEnvironment('),
      `${name} больше не разрешает адрес через пул окружений`,
    )
    assert.ok(
      source.includes('sessionEnvironment(sessionId)'),
      `${name} больше не спрашивает окружение у семинара`,
    )
    /*
     * Про defaultEndpoint() здесь проверки нет, и это осознанно: в terminal.ts
     * он стоит заглушкой в свежесозданной записи, до того как терминал вообще
     * открывали. Настоящий адрес спрашивается в openTerminal. Запрет на само
     * упоминание поймал бы эту строку и ничего бы этим не улучшил.
     */
  }
})

test('смена адреса обесценивает запомненное имя pty', () => {
  /*
   * pty с именем «1» есть в каждом контейнере. Запомнив имя из одного и
   * подключившись с ним к другому, терминал привёл бы комнату в чужую
   * оболочку — не в свою, но и не в пустоту, что хуже ошибки.
   */
  const source = read('server/src/kernel/terminal.ts')
  assert.ok(
    /if \(endpoint\.url !== term\.endpoint\.url\) term\.name = null/.test(source),
    'при смене адреса имя pty должно сбрасываться',
  )
})
