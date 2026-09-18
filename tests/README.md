# tests

`npm test` — Node's own test runner over `tests/*.test.mts`, through tsx. No new
dependency: tsx was already here for the e2e and perf harnesses.

These are unit tests, and they are deliberately narrow. The end-to-end harness
(`npm run e2e`) already proves that two browsers share a notebook, a kernel and
a workspace; `npm run perf` already guards the budgets. What neither can see is
the logic that fails *quietly*: a token that verifies when it should not, an
instance left with no owner, a context window that drops the traceback the
student asked about, a path that escapes the workspace, a colour nobody chose
that nobody can read, an online list that is empty for every real browser.

Anything needing a live server, a browser or a real kernel belongs in the e2e
harness instead.

`site.test.mts` is the odd one out in the other direction: it imports no module
at all. The landing page has no build step, no types and no other check —
`site/index.html` ships to Pages exactly as written — and three of its promises
had quietly drifted from what the file does: a cache-busting marker that had not
moved through five edits of the stylesheet, a seat count parsed with `parseInt`
out of a Russian sentence (`NaN`, so the door said "1 person inside" the moment
somebody walked in), and a decorative cursor layer inside the `<h1>` that a
screen reader read out along with the headline. Nothing in the repository would
have said so. What can be read out of that file is now read out of it here.

Two files are exceptions, and both earn it by covering a failure a real
component will not perform on request.

`kernel.test.mts` stands up a fake Jupyter — an http server and a websocket —
because the bug it covers is a kernel that dies *without saying so*: Jupyter
deletes a kernel and leaves the channels socket open, no close frame, no error.
That failure silently froze a whole seminar, and it needed a socket to
reproduce. The same fake also fails a cell on command, which is how the tests
for "Run All stops at the first traceback" build a notebook that breaks in the
middle without a real Python.

`terminal.test.mts` stands up a fake terminado for a narrower reason: what it
tests is the *order* things are written in when two people type into one shell,
and a real shell will not reliably hand you the race that caused the problem.

`--test-concurrency=1` is deliberate, and it is not about speed. Without it the
run silently *under-reports*: measured over repeated runs of the same unchanged
suite, the count came back 232, 232, 230, 232 — always the tail of one file,
never a failure. The serial run cost about twelve extra seconds and reported
every test. Both numbers are that one measurement and nothing more: the suite
was 232 tests then and is several times that now, and it has not been run
concurrently since, so read the twelve seconds as history rather than as
today's price of the flag. The real cost is printed at the end of every run, on
the `duration_ms` line, and the real count on the `ℹ tests` line beside it.
What outlived the numbers is the reason for the flag: a suite that quietly
drops its last two tests is worse than a slow one, because nothing about the
output says anything is missing.

`--test-force-exit` is deliberate. Importing a server module means importing
things that are built to keep running — a document binding schedules its next
snapshot, and a kernel client its next reconnect. That is correct for a server,
which is held up by its listening socket, and it is not something a unit test
should have to unwind. Without the flag the runner waits on a child that has
finished its work and has no intention of exiting, and a suite that takes 600 ms
takes three minutes to say so.

`npm test` preloads `tests/_cli.mts` after tsx.
It makes the test child's stdout synchronous before forced exit, so buffered
test events reach the parent. Without this preload Node 23.7 reported only
49 of 64 passing pult tests in one audit run; with it all 64 were reported.
Keep the preload when running a subset with `--test-force-exit`:
`node --import tsx --import ./tests/_cli.mts --test --test-force-exit tests/example.test.mts`.

## What a browser measured, and what lives here instead

Three of these files are the residue of things found in a real browser rather
than in a test:

`controls.test.mts` — with the page's sockets closed under it, the header told
the truth (the kernel pill dimmed to "Last known", a RECONNECTING spinner
appeared) and every Run button sat fully lit beside it. A press produced no
queue position and no word at all; three presses on one cell came back as three
runs when the network returned.

`notes.test.mts` — a Run All that stops at a failing cell writes *why* into the
shared terminal transcript, and the transcript lives in a drawer that starts
closed. The room had the reason on file and nothing on screen pointing at it.

`security-headers.test.mts` — fourteen hostile payloads written into a live
seminar from a second client. Nothing scriptable survived DOMPurify, but
`<style>` and `<form>` did, and `<style>@import "http://…"</style>` had every
browser in the room fetch a stranger's URL.

What can be decided without a DOM is decided in a plain module and tested here;
what needs pixels or a real DOMPurify is measured in a browser, and these files
carry the finding so it cannot be quietly undone.

## Клиентские модули: что проверяется здесь, а что только вживую

Всё, что можно решить без DOM, вынесено из компонентов в обычные модули
`web/src/lib/*` и проверяется отсюда. Пять файлов `weblib-*.test.mts` — про
то, что ломается молча в браузере, а не на экране:

`weblib-presence.test.mts` — кадр присутствия, в котором не изменилось ничего из
нарисованного, не должен доходить ни до кого. Интерфейс при этом остаётся
правильным; неправильной становится только скорость, и заметить это можно лишь
в зале на пятьсот человек.

`weblib-evidence.test.mts` — обрезанный список файлов и голый код состояния не
доказывают того, по чему делается необратимое: погашенная у всей комнаты
лекция, стёртая личность забаненного, стёртый офлайн-набор.

`weblib-refusal-cells.test.mts` — что человек прочитает после того, как вкладку
пересобрали отказом гейта: там решается, покажут ему потерянный текст или он
исчезнет молча.

`weblib-rule-rows.test.mts` — подписи правил комнаты: правило без строки
исчезает из панели, а значение, которого не знает `readRules`, рисуется
кнопкой, тихо возвращающейся на умолчание.

`weblib-one-copy.test.mts` — места, где одно правило успело обзавестись второй
копией и копии разошлись.

Два самых больших модуля клиента проверяются ТОЛЬКО вживую, и это осознанно:
`web/src/lib/yreactive.svelte.ts` и `web/src/lib/filedoc.svelte.ts` — мост
между Yjs и рунами Svelte. Их поведение — это подписки, эффекты и порядок
пробуждения компонентов; без компилятора Svelte и без документа в браузере
проверять там нечего, а подделка того и другого проверяла бы подделку. Что от
них зависит — считанные снимки и правила диффа — вынесено в модули без рун
(`lib/peers.ts`, `lib/room.ts`, `lib/board.ts`) и проверяется здесь.
