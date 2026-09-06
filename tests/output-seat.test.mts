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
  neverRan,
  ranQuietly,
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
 * касался: номер в поле — порядковый, он у обеих одинаков. Отсюда два знака —
 * пунктир под номером у незапущенной и строка «без вывода» у отработавшей
 * молча, — и оба обязаны быть взаимоисключающими: два знака сразу на одной
 * ячейке говорят противоположное.
 */
const CELL = {
  type: "code",
  state: "idle",
  execCount: null,
  outputs: 0,
  floor: 0,
  running: false,
} as const;

test("свежая ячейка кода — не запускалась; заметка не помечается никогда", () => {
  assert.equal(neverRan(CELL), true);
  // У заметки нет ни запуска, ни номера выполнения: пунктир под её номером
  // обещал бы кнопку, которой у неё не бывает.
  assert.equal(neverRan({ ...CELL, type: "markdown" }), false);
});

test("посчитанная ячейка теряет пунктир — по номеру или по выводу", () => {
  assert.equal(neverRan({ ...CELL, execCount: 3 }), false);
  /*
   * Вывод без номера — это «считалась». Номер теряется при перезапуске ядра и
   * возврате версии (см. unnumberedResult выше), а факт выполнения нет, и
   * пунктир на ячейке с настоящим выводом на экране был бы прямой неправдой.
   */
  assert.equal(neverRan({ ...CELL, outputs: 2 }), false);
  assert.equal(unnumberedResult({ state: "idle", execCount: null, outputs: 2 }), true);
});

test("пока считает и пока стоит в очереди — молчим", () => {
  // Про эти две и так сказано: полосой у края, строкой Running и чипом очереди.
  assert.equal(neverRan({ ...CELL, running: true }), false);
  assert.equal(neverRan({ ...CELL, state: "queued" }), false);
  assert.equal(ranQuietly({ ...CELL, execCount: 3, running: true }), false);
  assert.equal(ranQuietly({ ...CELL, execCount: 3, state: "queued" }), false);
});

test("отработала молча — это номер выполнения без единой записи вывода", () => {
  assert.equal(ranQuietly({ ...CELL, execCount: 3 }), true);
  // С выводом говорит сам вывод, и под ним стоит та же метка Out [n].
  assert.equal(ranQuietly({ ...CELL, execCount: 3, outputs: 1 }), false);
  // Без номера сказать «Out [n]» нечем.
  assert.equal(ranQuietly(CELL), false);
});

test("зарезервированное место молчит: вывод вот-вот появится", () => {
  /*
   * Между стартом и первым байтом ячейка держит высоту прошлого вывода
   * (outputSeat выше). Сказать в этот промежуток «без вывода» значит соврать
   * на полкадра — и соврать заметно, потому что строка встанет ровно там, где
   * через мгновение будет вывод.
   */
  assert.equal(ranQuietly({ ...CELL, execCount: 3, floor: 420 }), false);
});

test("два знака не встречаются на одной ячейке", () => {
  for (const execCount of [null, 7]) {
    for (const outputs of [0, 3]) {
      for (const floor of [0, 420]) {
        const cell = { ...CELL, execCount, outputs, floor };
        assert.ok(
          !(neverRan(cell) && ranQuietly(cell)),
          `и пунктир, и «без вывода»: ${JSON.stringify({ execCount, outputs, floor })}`,
        );
      }
    }
  }
});
