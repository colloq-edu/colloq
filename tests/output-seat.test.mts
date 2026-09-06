/**
 * Место, которое ячейка не отдаёт, пока считает.
 *
 * Перезапуск ячейки с выводом схлопывал её и отрисовывал заново. Вывод
 * по-прежнему стирается сразу — прошлое число, выглядящее свежим, хуже рывка,
 * — а высота остаётся, и разжимается ровно один раз. Всё, что здесь
 * проверяется, ломается молча: в быстром тесте без картинок и без отступов
 * любая из этих ошибок выглядит совершенно правильно.
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

test("ячейка, которая не считает, не резервирует ничего", () => {
  // Ручной Clear в покое и ячейка в очереди схлопываются ровно как раньше.
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

test("место держится, только пока показывать нечего", () => {
  assert.equal(
    outputSeat({
      running: true,
      outputs: 0,
      pendingImages: 0,
      held: { px: 900, fromError: false },
    }),
    900,
  );
  // Содержимое появилось — пол не нужен: дальше высоту держит оно само.
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

test("нераскодированная картинка удерживает место", () => {
  // Иначе: 900 пикселей резерва → восьмипиксельная белая полоска → рывок
  // обратно на 900. Три состояния вместо обещанной неподвижности.
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

test("место никогда не добавляет высоты", () => {
  // Нажатие Run не может заставить ячейку вырасти.
  for (const outputs of [0, 1]) {
    for (const pendingImages of [0, 1]) {
      assert.equal(
        outputSeat({ running: true, outputs, pendingImages, held: NO_HELD }),
        0,
      );
    }
  }
});

test("собственные отступы пустой области не становятся резервом", () => {
  // Пустая область меряет десяток пикселей своих отступов. Записать их —
  // значит затереть девятисотпиксельный резерв, и в следующий раз ячейка не
  // зарезервирует ничего.
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

test("очищенная руками ячейка забывает свою высоту", () => {
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

test("нераскодированная картинка не портит запомненную высоту", () => {
  // График в девятьсот пикселей иначе запомнился бы как двадцать.
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

test("обмеренная высота запоминается, когда её есть с чего взять", () => {
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

test("номер отнимают только там, где его правда отняли", () => {
  const has = { outputs: 1, execCount: null, state: "idle" as const };
  assert.equal(unnumberedResult(has), true);
  // Ядро умерло до execute_input: номера нет, но выполнение было — и трейсбек
  // под ним свежий.
  assert.equal(unnumberedResult({ ...has, state: "error" }), false);
  assert.equal(unnumberedResult({ ...has, execCount: 12 }), false);
  assert.equal(unnumberedResult({ ...has, outputs: 0 }), false);
});

test("место, сменившее содержимое, получает новый ключ; выросший поток — прежний", () => {
  const grew = outputKey(0, { kind: "stream", name: "stdout" });
  assert.equal(grew, outputKey(0, { kind: "stream", name: "stdout" }));
  // Трейсбек, заменённый графиком в том же месте, обязан пересобраться: иначе
  // график рисуется подрезанным по запомненной высоте трейсбека.
  assert.notEqual(
    outputKey(0, { kind: "error" }),
    outputKey(0, { kind: "data" }),
  );
  // stdout и stderr в одном месте — тоже разные вещи.
  assert.notEqual(
    outputKey(0, { kind: "stream", name: "stdout" }),
    outputKey(0, { kind: "stream", name: "stderr" }),
  );
});

test("упавший вывод места не держит", () => {
  /*
   * Место резервируют в расчёте на то, что новый вывод будет примерно того же
   * размера. Для ячейки, перезапускаемой без изменений, это верно; для
   * упавшей — неверно ровно наоборот: её перезапускают, ПОТОМУ ЧТО в ней
   * что-то поменяли. А трейсбеки высокие, и полэкрана пустоты в расчёте на
   * то, чего не будет, — это и есть то, о чём сообщили как о баге.
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
    "трейсбек зарезервировал под себя место",
  );

  // А удачный вывод того же роста — держит.
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

/* ------------------------------------------------- запускалась ли она вообще */

/**
 * Ячейка без вывода после запуска выглядела ровно как та, которой никто не
 * касался: номер в поле — порядковый, он у обеих одинаков, а строка `Out [n]`
 * рисовалась только под выводом. Метка отвечает на это у ВСЯКОЙ ячейки кода —
 * и ошибиться здесь легко в обе стороны: сказать «не запускалась» над живым
 * выводом или, наоборот, не сказать этого над пустой ячейкой.
 */
const CELL = {
  type: "code",
  state: "idle",
  execCount: null,
  outputs: 0,
  running: false,
} as const;

test("свежая ячейка — пустые скобки; у заметки метки нет вовсе", () => {
  assert.deepEqual(runMark(CELL), { label: "[ ]", tone: "idle" });
  // У заметки не бывает запуска: пустые скобки под её номером обещали бы
  // кнопку, которой у неё нет.
  assert.equal(runMark({ ...CELL, type: "markdown" }), null);
});

test("посчитанная показывает свой номер, упавшая — свой, и красным", () => {
  assert.deepEqual(runMark({ ...CELL, execCount: 7, state: "ok" }), {
    label: "[7]",
    tone: "done",
  });
  assert.deepEqual(runMark({ ...CELL, execCount: 8, state: "error", outputs: 1 }), {
    label: "[8]",
    tone: "error",
  });
});

test("считает и стоит в очереди — звёздочка: номер даст ядро", () => {
  assert.deepEqual(runMark({ ...CELL, running: true }), { label: "[*]", tone: "busy" });
  assert.deepEqual(runMark({ ...CELL, state: "queued" }), { label: "[*]", tone: "busy" });
  // Звёздочка старше номера: перезапуск посчитанной ячейки показывает её ход,
  // а не число с прошлого раза.
  assert.deepEqual(runMark({ ...CELL, execCount: 3, running: true }), {
    label: "[*]",
    tone: "busy",
  });
});

test("считалась, а номера нет — прочерк, а не пустые скобки", () => {
  /*
   * Три разных случая, и во всех «не запускалась» было бы прямой неправдой:
   * пустая ячейка (Jupyter номера не выдаёт вовсе), перезапуск ядра и возврат
   * версии — у последних двух на экране настоящий вывод.
   */
  assert.deepEqual(runMark({ ...CELL, state: "ok" }), { label: "[—]", tone: "lost" });
  assert.deepEqual(runMark({ ...CELL, outputs: 2 }), { label: "[—]", tone: "lost" });
  assert.equal(unnumberedResult({ state: "idle", execCount: null, outputs: 2 }), true);
  // Упала без номера — прочерк, но красный: сначала важно, что упала.
  assert.deepEqual(runMark({ ...CELL, state: "error" }), { label: "[—]", tone: "error" });
});

test("метка всегда ровно три знака — на ней держится вертикаль", () => {
  /*
   * Скобки стоят колонкой на всю тетрадь, и лист читается сверху вниз одним
   * взглядом. Четвёртый знак у любой из них — и колонка разъезжается.
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
    assert.ok(mark, "метки нет");
    assert.equal(mark!.label.length, 3, `«${mark!.label}» не в три знака`);
    assert.ok(mark!.label.startsWith("[") && mark!.label.endsWith("]"));
  }
  // Двузначный номер шире — и это правильно: число важнее вертикали, а
  // тетрадей с сотней запусков не бывает.
  assert.equal(runMark({ ...CELL, execCount: 12 })!.label, "[12]");
});
