# Browser reconnect regression

Run `npm ci`, `npx playwright install chromium`, `npm run build`, then
`npm run test:browser`. The suite starts its own loopback server on port 4317,
refuses to reuse an existing server, and uses a temporary database/workspace.
It never attaches to an existing Colloq instance or the user's browser profile.
Python execution is the test backend; real execution is covered separately by
`COLLOQ_RESTORE_DOCKER_TEST=1`.

The tests use the real UI, Yjs/control sockets and storage. They temporarily close
forwarded sockets, edit while disconnected, reconnect, and verify shared changes
and council A → B → A from a fresh browser context without IndexedDB state.
Only connection availability is controlled; server responses are not fabricated.
Code assertions exclude the remote-cursor name widgets from rendered code lines.

`markdown.spec.ts` covers what other people's notes may do to the page they
are drawn into: the app's own classes, popovers, ids and `data-*` names, and a
`data-math` that imitates the renderer's formula placeholders. It needs
the production build because the overlay it guards against is made of the app's
real utility classes, and only the built stylesheet says what they do. Its rooms
are seeded in `server.mts` with fixed cell ids. `outputs.spec.ts` does the same
for rich kernel output: a stylesheet in an output, `:host` included, must stay
inside the output's box while pandas-style and SVG rules still style it.

Playwright's [web server lifecycle](https://playwright.dev/docs/test-webserver)
and [WebSocket routing](https://playwright.dev/docs/api/class-websocketroute)
provide the isolated server and controlled connection loss. CI retains traces
only on failure; they contain test fixture text and expire after seven days.
