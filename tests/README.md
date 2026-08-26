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
never a failure. A suite that quietly drops its last two tests is worse than a
slow one, because nothing about the output says anything is missing. Serial runs
cost about twelve extra seconds and always report every test.

`--test-force-exit` is deliberate. Importing a server module means importing
things that are built to keep running — a document binding schedules its next
snapshot, and a kernel client its next reconnect. That is correct for a server,
which is held up by its listening socket, and it is not something a unit test
should have to unwind. Without the flag the runner waits on a child that has
finished its work and has no intention of exiting, and a suite that takes 600 ms
takes three minutes to say so.

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
