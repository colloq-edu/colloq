/**
 * Вывод дочернего процесса node --test не должен теряться под --test-force-exit.
 *
 * Корневой `npm test` идёт с --test-force-exit, а он выходит через
 * process.exit(). Дочерний процесс каждого файла пишет отчёт в ТРУБУ к
 * запускающему, запись в трубу асинхронная, и process.exit() обрывает её на
 * полуслове: прогон показывал «pass 4» вместо «pass 27» — и код выхода был 0.
 * Зелёное там ничего не доказывало.
 *
 * Один вызов setBlocking делает запись синхронной, и отчёт доезжает целиком.
 * Импортировать первой строкой в каждом файле группы CLI.
 */
const handle = (process.stdout as unknown as { _handle?: { setBlocking?(on: boolean): void } })
  ._handle
handle?.setBlocking?.(true)

export {}
