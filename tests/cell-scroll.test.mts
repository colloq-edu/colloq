/**
 * Two pieces of notebook scrolling arithmetic.
 *
 * Both break silently, and both were measured on a test bench rather than
 * derived from general considerations: "a jump lands anywhere", "the sheet
 * twitches upward" and "I run a cell and get thrown down" are complaints from
 * a class, not hypotheses. The numbers in the checks come from the same
 * measurement: an 809 px cell on a 705 px screen, a 240 px placeholder, a
 * 28 px toolbar.
 *
 * Running comes here too — recently, and through a third complaint: "in Colab
 * after a run it scrolls down to the bottom of the output, while our notebook
 * stays put". It is the exact opposite of the second one, and a single
 * condition reconciles them: move only if the bottom of the output is not
 * visible. And only for a SINGLE run: during "Run all" the sheet does not move
 * at all (the analysis is in Notebook · follow). The checks for this are at
 * the end of the file.
 */
import "./_env.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterRun,
  anchorShift,
  BREATH,
  measurable,
  nearestTarget,
  TAIL,
  TOOLBAR_FALLBACK,
} from "../web/src/lib/cell-scroll.js";

const BAR = 28;
const ROOM = BAR + BREATH;

test("a cell below the screen arrives with its bottom edge at the bottom, and not a pixel more", () => {
  /*
   * The most common jump: a short cell that starts right past the bottom
   * edge. It used to be brought top to the top of the screen — that is
   * 780 - ROOM pixels of travel for a cell of eighty.
   */
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 780, bottom: 860, toolbar: BAR },
  );
  assert.equal(target, 1000 + (860 - 705));
});

test("a long cell from below arrives top first, not with its last line", () => {
  // Bottom to bottom, its top would go off screen: you would see the last line
  // of forty. So the travel is capped at "top under the top", with room for
  // the toolbar.
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 760, bottom: 1569, toolbar: BAR },
  );
  assert.equal(target, 1000 + 760 - ROOM);
});

test("a cell above the screen lands with its top under the top, with room for the toolbar", () => {
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 3000 },
    { top: -420, bottom: -60, toolbar: BAR },
  );
  assert.equal(target, 3000 - 420 - ROOM);
});

test("if even an edge is visible, the screen does not move at all", () => {
  /*
   * The main rule of a jump, and exactly what was missing: a cell reached with
   * the arrow key that is already in view must not move a single line under
   * the person. Three cases: entirely inside, the bottom edge off screen, the
   * top edge above the screen.
   */
  const frame = { top: 0, bottom: 705, scrollTop: 1000 };
  assert.equal(nearestTarget(frame, { top: 200, bottom: 400, toolbar: BAR }), null);
  assert.equal(nearestTarget(frame, { top: 640, bottom: 1449, toolbar: BAR }), null);
  assert.equal(nearestTarget(frame, { top: -300, bottom: 60, toolbar: BAR }), null);
});

test("a toolbar past the top edge is not yet a reason to move", () => {
  /*
   * The toolbar hangs ABOVE the cell and is not part of its rectangle, and a
   * cell sitting two pixels from the edge used to move for its sake. For a
   * jump that is needless motion: the cell is visible, people reach for the
   * toolbar with the mouse and on hover, and room for it counts only where the
   * cell really is brought in top first.
   */
  assert.equal(
    nearestTarget(
      { top: 0, bottom: 705, scrollTop: 1000 },
      { top: 2, bottom: 300, toolbar: BAR },
    ),
    null,
  );
});

test("we do not scroll above the start of the sheet", () => {
  assert.equal(
    nearestTarget(
      { top: 0, bottom: 705, scrollTop: 5 },
      { top: -900, bottom: -10, toolbar: BAR },
    ),
    0,
  );
});

test("a pixel of difference is no reason for an animation frame", () => {
  // A cell right at the bottom edge and just a pixel lower: the move would be
  // a jitter.
  assert.equal(
    nearestTarget(
      { top: 0, bottom: 705, scrollTop: 1000 },
      { top: 705, bottom: 705.5, toolbar: BAR },
    ),
    null,
  );
});

test("the toolbar height of a cell not yet built is a fallback number, not zero", () => {
  // Room for the toolbar is needed even when the toolbar itself is not in the
  // DOM yet.
  assert.ok(TOOLBAR_FALLBACK > 0);
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 900, bottom: 1709, toolbar: TOOLBAR_FALLBACK },
  );
  assert.equal(target, 1000 + 900 - TOOLBAR_FALLBACK - BREATH);
});

test("a cell that grew above the screen shifts the scroll by exactly its growth", () => {
  // A 240 px placeholder became an 809 px cell: the screen must stay in place.
  assert.equal(anchorShift([{ top: 8842, delta: 569 }], 10192), 569);
});

test("several neighbours within one frame add up", () => {
  assert.equal(
    anchorShift(
      [
        { top: 9634, delta: -160 },
        { top: 9738, delta: 636 },
        { top: 10638, delta: -160 },
      ],
      11000,
    ),
    316,
  );
});

test("what grows in plain sight is left alone", () => {
  /*
   * A cell whose top is on screen or below grows in plain view: a correction
   * here would itself become a jerk — the screen would move against what the
   * person is reading right now.
   */
  assert.equal(anchorShift([{ top: 5000, delta: 569 }], 4000), 0);
  // Exactly at the edge too: such a cell grows entirely into the screen.
  assert.equal(anchorShift([{ top: 4000, delta: 569 }], 4000), 0);
  // But one pixel above the edge, it already moves everything below it.
  assert.equal(anchorShift([{ top: 3999, delta: 569 }], 4000), 569);
});

test("nothing changed, nothing moves", () => {
  assert.equal(anchorShift([], 4000), 0);
});

/* -------------------------------------------------------- hidden tab */

/**
 * The complaint: "I jump to a script with cmd+click from the fourth cell,
 * close it, come back — and the notebook has scrolled down to the tenth".
 *
 * The numbers were measured in Chrome on a separate page: for a
 * `display: none` container `getBoundingClientRect()` gives zeros, `scrollTop`
 * reads as zero, and once it is shown again the browser itself restores the
 * previous 1500. So it is not the browser that loses the scroll — our own
 * anchor carries it away if we let it measure zeros.
 */
test("a frame that is not on screen cannot be measured", () => {
  assert.equal(measurable({ top: 0, bottom: 705 }), true);
  // Exactly what reads from a hidden tab.
  assert.equal(measurable({ top: 0, bottom: 0 }), false);
  // A degenerate layout: the strip is above the container. Nothing to measure
  // either.
  assert.equal(measurable({ top: 40, bottom: 12 }), false);
});

test("zero heights from a hidden tab would have moved the screen by the whole notebook", () => {
  /*
   * What happened without the check. The anchor recorded zero for every cell,
   * and on return saw the real heights — which to it is growth above the
   * screen. Six cells of 809 above the target make 4854 px, exactly the
   * difference between the fourth cell and the tenth.
   */
  const asIfGrown = Array.from({ length: 6 }, (_, index) => ({
    top: index * 809,
    delta: 809,
  }));
  assert.equal(anchorShift(asIfGrown, 4854), 4854);
});

/* ----------------------------------------------- moving after a run */

/** A 705 px screen and a 28 px toolbar, as in the rest of the file. */
const ran = { top: 0, bottom: 705, scrollTop: 1000 };

test("a cell whose output already fits is not moved at all", () => {
  assert.equal(afterRun(ran, { top: 200, bottom: 705 - TAIL, toolbar: BAR }), null);
});

test("an output hanging below the fold is brought up, plus room for what follows", () => {
  // The bottom is 200 px below the screen: bring it up, plus a gap.
  assert.equal(afterRun(ran, { top: 300, bottom: 905, toolbar: BAR }), 1000 + 200 + TAIL);
});

test("a cell taller than the screen arrives top first, not last line first", () => {
  /*
   * The same cap as for an arrow-key jump: the "bottom of the output" of a cell
   * three screens tall is its last line, and bringing that up means carrying
   * the code and the start of the output off the top edge.
   */
  assert.equal(afterRun(ran, { top: 400, bottom: 2800, toolbar: BAR }), 1000 + 400 - ROOM);
});

test("running never pulls the sheet upwards", () => {
  // A cell above the screen: "bring up the bottom" would mean moving UP, so
  // we do not.
  assert.equal(afterRun(ran, { top: -900, bottom: -100, toolbar: BAR }), null);
});

test("nothing is decided from a hidden tab, running or not", () => {
  const hidden = { top: 0, bottom: 0, scrollTop: 0 };
  assert.equal(afterRun(hidden, { top: 300, bottom: 905, toolbar: BAR }), null);
});

/*
 * The sheet follows a text cell the same way it follows a code cell.
 *
 * For code it is driven by the kernel's `runningCellId` changing; a note has
 * no kernel, and while it stayed silent, Shift+Enter down the notebook
 * stumbled on every text cell: the cursor moved on, the screen stood still
 * (19 Sep 2026). The check reads the sources: the note speaks for itself, and
 * Notebook answers with the same `follow`.
 */
test("a text cell reports that it settled, and the notebook follows it like a code cell", async () => {
  const { readFileSync } = await import("node:fs");
  const cell = readFileSync(new URL("../web/src/components/notebook/CellView.svelte", import.meta.url), "utf8");
  const book = readFileSync(new URL("../web/src/components/notebook/Notebook.svelte", import.meta.url), "utf8");
  assert.match(
    cell,
    /commitMarkdown\(\)[\s\S]{0,900}?dispatchEvent\(new CustomEvent\('colloq:cell-settled', \{ detail: \{ cellId: id \} \}\)\)[\s\S]{0,40}?return true/,
    "the note rendered silently, so the sheet will not follow it",
  );
  assert.match(
    book,
    /addEventListener\('colloq:cell-settled', onSettled\)/,
    "Notebook does not listen for a note being rendered",
  );
  assert.match(
    book,
    /onSettled = [\s\S]{0,400}?ids\.current\.includes\(cellId\)[\s\S]{0,120}?tick\(\)\.then\(\(\) => follow\(cellId\)\)/,
    "following a note must go through the same follow, and only in its own notebook",
  );
});
