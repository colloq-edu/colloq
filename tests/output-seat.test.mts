/**
 * The space a cell does not give up while it computes.
 *
 * Rerunning a cell with output collapsed it and drew it again. The output is
 * still erased at once — an old number that looks fresh is worse than a jump —
 * but the height stays, and it is released exactly once. Everything checked
 * here breaks silently: in a quick test without images and without padding,
 * any of these mistakes looks perfectly right.
 */
import "./_env.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextHeld,
  NO_HELD,
  outputKey,
  outputSeat,
  unnumberedResult,
  runMark,
} from "../web/src/lib/output-seat.js";

test("a cell that is not computing reserves nothing", () => {
  // A manual Clear at rest and a queued cell collapse exactly as before.
  for (const held of [0, 12, 900]) {
    assert.equal(
      outputSeat({
        running: false,
        outputs: 0,
        pendingImages: 0,
        held: { px: held, fromError: false },
      }),
      0,
    );
    assert.equal(
      outputSeat({
        running: false,
        outputs: 1,
        pendingImages: 0,
        held: { px: held, fromError: false },
      }),
      0,
    );
  }
});

test("the space is held only while there is nothing to show", () => {
  assert.equal(
    outputSeat({
      running: true,
      outputs: 0,
      pendingImages: 0,
      held: { px: 900, fromError: false },
    }),
    900,
  );
  // Content has appeared, so no floor is needed: from here on it holds the height itself.
  assert.equal(
    outputSeat({
      running: true,
      outputs: 1,
      pendingImages: 0,
      held: { px: 900, fromError: false },
    }),
    0,
  );
});

test("an image not yet decoded holds the space", () => {
  // Otherwise: 900 pixels reserved → an eight-pixel white strip → a jump back
  // to 900. Three states instead of the promised stillness.
  assert.equal(
    outputSeat({
      running: true,
      outputs: 1,
      pendingImages: 1,
      held: { px: 900, fromError: false },
    }),
    900,
  );
});

test("the reserved space never adds height", () => {
  // Pressing Run cannot make a cell grow.
  for (const outputs of [0, 1]) {
    for (const pendingImages of [0, 1]) {
      assert.equal(
        outputSeat({ running: true, outputs, pendingImages, held: NO_HELD }),
        0,
      );
    }
  }
});

test("the empty area's own padding does not become the reserve", () => {
  // An empty area measures a dozen pixels of its own padding. Recording them
  // would overwrite the nine-hundred-pixel reserve, and next time the cell
  // would reserve nothing.
  assert.deepEqual(
    nextHeld(
      { px: 900, fromError: false },
      {
        running: true,
        outputs: 0,
        pendingImages: 0,
        measured: 12,
        hasError: false,
      },
    ),
    { px: 900, fromError: false },
  );
});

test("a cell cleared by hand forgets its height", () => {
  assert.deepEqual(
    nextHeld(
      { px: 900, fromError: false },
      {
        running: false,
        outputs: 0,
        pendingImages: 0,
        measured: 0,
        hasError: false,
      },
    ),
    NO_HELD,
  );
});

test("an image not yet decoded does not spoil the remembered height", () => {
  // Otherwise a nine-hundred-pixel chart would be remembered as twenty.
  assert.deepEqual(
    nextHeld(
      { px: 900, fromError: false },
      {
        running: true,
        outputs: 1,
        pendingImages: 1,
        measured: 20,
        hasError: false,
      },
    ),
    { px: 900, fromError: false },
  );
});

test("a measured height is remembered when there is something to take it from", () => {
  assert.deepEqual(
    nextHeld(NO_HELD, {
      running: true,
      outputs: 2,
      pendingImages: 0,
      measured: 340,
      hasError: false,
    }),
    { px: 340, fromError: false },
  );
});

test("the number is taken away only where it really was taken away", () => {
  const has = { outputs: 1, execCount: null, state: "idle" as const };
  assert.equal(unnumberedResult(has), true);
  // The kernel died before execute_input: there is no number, but there was a
  // run — and the traceback under it is fresh.
  assert.equal(unnumberedResult({ ...has, state: "error" }), false);
  assert.equal(unnumberedResult({ ...has, execCount: 12 }), false);
  assert.equal(unnumberedResult({ ...has, outputs: 0 }), false);
});

test("a slot whose content changed gets a new key; a stream that grew keeps the old one", () => {
  const grew = outputKey(0, { kind: "stream", name: "stdout" });
  assert.equal(grew, outputKey(0, { kind: "stream", name: "stdout" }));
  // A traceback replaced by a chart in the same slot has to be rebuilt:
  // otherwise the chart is drawn clipped to the traceback's remembered height.
  assert.notEqual(
    outputKey(0, { kind: "error" }),
    outputKey(0, { kind: "data" }),
  );
  // stdout and stderr in one slot are different things too.
  assert.notEqual(
    outputKey(0, { kind: "stream", name: "stdout" }),
    outputKey(0, { kind: "stream", name: "stderr" }),
  );
});

test("failed output holds no space", () => {
  /*
   * Space is reserved on the assumption that the new output will be about the
   * same size. For a cell rerun without changes that holds; for a failed one it
   * is exactly wrong: it is rerun BECAUSE something in it was changed. And
   * tracebacks are tall, and half a screen of emptiness reserved for what will
   * not come is exactly what was reported as a bug.
   */
  const afterError = nextHeld(NO_HELD, {
    running: true,
    outputs: 1,
    pendingImages: 0,
    measured: 444,
    hasError: true,
  });
  assert.deepEqual(afterError, { px: 444, fromError: true });
  assert.equal(
    outputSeat({
      running: true,
      outputs: 0,
      pendingImages: 0,
      held: afterError,
    }),
    0,
    "the traceback reserved space for itself",
  );

  // But a successful output of the same height does hold it.
  const afterOk = nextHeld(NO_HELD, {
    running: true,
    outputs: 1,
    pendingImages: 0,
    measured: 444,
    hasError: false,
  });
  assert.equal(
    outputSeat({ running: true, outputs: 0, pendingImages: 0, held: afterOk }),
    444,
  );
});

/* ---------------------------------------------------- was it ever run at all */

/**
 * A cell with no output after a run looked exactly like one nobody had
 * touched: the number in the gutter is an ordinal, the same for both, and the
 * `Out [n]` line was drawn only under output. The mark answers this for EVERY
 * code cell — and it is easy to get wrong both ways: to say "never run" over
 * live output or, conversely, not to say it over an empty cell.
 */
const CELL = {
  type: "code",
  state: "idle",
  execCount: null,
  outputs: 0,
  running: false,
} as const;

test("a fresh cell gets empty brackets; a note has no mark at all", () => {
  assert.deepEqual(runMark(CELL), { label: "[ ]", tone: "idle" });
  // A note is never run: empty brackets under its number would promise a
  // button it does not have.
  assert.equal(runMark({ ...CELL, type: "markdown" }), null);
});

test("a computed cell shows its number, a failed one shows its own, in red", () => {
  assert.deepEqual(runMark({ ...CELL, execCount: 7, state: "ok" }), {
    label: "[7]",
    tone: "done",
  });
  assert.deepEqual(runMark({ ...CELL, execCount: 8, state: "error", outputs: 1 }), {
    label: "[8]",
    tone: "error",
  });
});

test("computing and queued get an asterisk: the kernel will give the number", () => {
  assert.deepEqual(runMark({ ...CELL, running: true }), { label: "[*]", tone: "busy" });
  assert.deepEqual(runMark({ ...CELL, state: "queued" }), { label: "[*]", tone: "busy" });
  // The asterisk outranks the number: rerunning a computed cell shows it in
  // progress, not the number from last time.
  assert.deepEqual(runMark({ ...CELL, execCount: 3, running: true }), {
    label: "[*]",
    tone: "busy",
  });
});

test("computed but without a number gets a dash, not empty brackets", () => {
  /*
   * Three different cases, and in all of them "never run" would be a plain lie:
   * an empty cell (Jupyter gives no number at all), a kernel restart and a
   * version restore — the last two have real output on screen.
   */
  assert.deepEqual(runMark({ ...CELL, state: "ok" }), { label: "[—]", tone: "lost" });
  assert.deepEqual(runMark({ ...CELL, outputs: 2 }), { label: "[—]", tone: "lost" });
  assert.equal(unnumberedResult({ state: "idle", execCount: null, outputs: 2 }), true);
  // Failed without a number: a dash, but red — what matters first is that it failed.
  assert.deepEqual(runMark({ ...CELL, state: "error" }), { label: "[—]", tone: "error" });
});

test("the mark is always exactly three characters: the vertical alignment rests on it", () => {
  /*
   * The brackets stand in a column down the whole notebook, and the sheet reads
   * top to bottom at a glance. A fourth character in any of them and the column falls apart.
   */
  const cells = [
    CELL,
    { ...CELL, running: true },
    { ...CELL, state: "queued" as const },
    { ...CELL, state: "ok" as const },
    { ...CELL, execCount: 1 },
    { ...CELL, execCount: 9, state: "error" as const },
  ];
  for (const cell of cells) {
    const mark = runMark(cell);
    assert.ok(mark, "no mark");
    assert.equal(mark!.label.length, 3, `"${mark!.label}" is not three characters`);
    assert.ok(mark!.label.startsWith("[") && mark!.label.endsWith("]"));
  }
  // A two-digit number is wider — and that is right: the number matters more
  // than the alignment, and there are no notebooks with a hundred runs.
  assert.equal(runMark({ ...CELL, execCount: 12 })!.label, "[12]");
});
