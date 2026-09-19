/**
 * Две арифметики прокрутки тетради.
 *
 * Обе ломаются молча и обе мерены на стенде, а не выведены из общих
 * соображений: «переход попадает куда попало», «лист дёргается вверх» и
 * «запускаю ячейку, а меня перекидывает вниз» — это жалобы с занятия, а не
 * гипотезы. Числа в проверках взяты из того же замера: ячейка 809 px на экране
 * 705, заглушка 240 px, тулбар 28 px.
 *
 * Запуск сюда тоже приходит — с недавних пор и по третьей жалобе: «в Колабе
 * после запуска спускается к низу вывода, а у нас тетрадь стоит». Она прямо
 * противоположна второй, и мирит их одно условие: двигаем, только если низа
 * вывода не видно. И только у ОДИНОЧНОГО запуска: за «Запустить всё» лист не
 * ходит вовсе (разбор — Notebook · follow). Проверки на это — в конце файла.
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

test("ячейка ниже экрана приезжает нижним краем к нижнему, и ни пикселем больше", () => {
  /*
   * Самый частый переход: короткая ячейка, начавшаяся сразу за нижним краем.
   * Раньше её подводили верхом к верху экрана — это 780 - ROOM пикселей хода
   * ради ячейки в восемьдесят.
   */
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 780, bottom: 860, toolbar: BAR },
  );
  assert.equal(target, 1000 + (860 - 705));
});

test("длинная ячейка снизу приезжает верхом, а не последней строкой", () => {
  // Нижним краем к нижнему её верх ушёл бы за экран: видно последнюю строку из
  // сорока. Значит ход ограничен «верхом под верх», с местом под тулбар.
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 760, bottom: 1569, toolbar: BAR },
  );
  assert.equal(target, 1000 + 760 - ROOM);
});

test("ячейка выше экрана встаёт верхом под верх, с местом под тулбар", () => {
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 3000 },
    { top: -420, bottom: -60, toolbar: BAR },
  );
  assert.equal(target, 3000 - 420 - ROOM);
});

test("видно хоть краем — экран не двигаем вовсе", () => {
  /*
   * Главное правило перехода и ровно то, чего не хватало: ячейка, до которой
   * дошли стрелкой и которая уже на виду, не должна двигать под человеком ни
   * строки. Три случая: целиком внутри, нижним краем за экран, верхним краем
   * над экраном.
   */
  const frame = { top: 0, bottom: 705, scrollTop: 1000 };
  assert.equal(nearestTarget(frame, { top: 200, bottom: 400, toolbar: BAR }), null);
  assert.equal(nearestTarget(frame, { top: 640, bottom: 1449, toolbar: BAR }), null);
  assert.equal(nearestTarget(frame, { top: -300, bottom: 60, toolbar: BAR }), null);
});

test("тулбар за верхним краем — это ещё не повод ехать", () => {
  /*
   * Тулбар висит НАД ячейкой и в её прямоугольник не входит, и раньше ячейка,
   * стоящая в двух пикселях от края, ехала ради него. Для перехода это лишнее
   * движение: ячейку видно, к тулбару тянутся мышью и по наведению, а место
   * под него считается только там, где ячейку и правда подводят верхом.
   */
  assert.equal(
    nearestTarget(
      { top: 0, bottom: 705, scrollTop: 1000 },
      { top: 2, bottom: 300, toolbar: BAR },
    ),
    null,
  );
});

test("выше начала листа не увозим", () => {
  assert.equal(
    nearestTarget(
      { top: 0, bottom: 705, scrollTop: 5 },
      { top: -900, bottom: -10, toolbar: BAR },
    ),
    0,
  );
});

test("пиксель разницы — не повод для кадра анимации", () => {
  // Ячейка ровно за нижним краем и ровно на пиксель ниже: ход был бы дрожью.
  assert.equal(
    nearestTarget(
      { top: 0, bottom: 705, scrollTop: 1000 },
      { top: 705, bottom: 705.5, toolbar: BAR },
    ),
    null,
  );
});

test("высота тулбара у непостроенной ячейки — запасное число, а не ноль", () => {
  // Место под тулбар нужно и тогда, когда самого тулбара в DOM ещё нет.
  assert.ok(TOOLBAR_FALLBACK > 0);
  const target = nearestTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 900, bottom: 1709, toolbar: TOOLBAR_FALLBACK },
  );
  assert.equal(target, 1000 + 900 - TOOLBAR_FALLBACK - BREATH);
});

test("выросшая выше экрана ячейка двигает прокрутку ровно на свой прирост", () => {
  // Заглушка в 240 px стала ячейкой в 809: экран обязан остаться на месте.
  assert.equal(anchorShift([{ top: 8842, delta: 569 }], 10192), 569);
});

test("несколько соседей за один кадр складываются", () => {
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

test("то, что растёт на глазах, не трогаем", () => {
  /*
   * Ячейка, чей верх на экране или ниже, растёт у человека на виду: поправка
   * тут сама стала бы рывком — экран поехал бы навстречу тому, что человек
   * как раз читает.
   */
  assert.equal(anchorShift([{ top: 5000, delta: 569 }], 4000), 0);
  // И ровно по краю тоже: такая ячейка растёт целиком внутрь экрана.
  assert.equal(anchorShift([{ top: 4000, delta: 569 }], 4000), 0);
  // А на пиксель выше края — уже двигает всё, что под ней.
  assert.equal(anchorShift([{ top: 3999, delta: 569 }], 4000), 569);
});

test("ничего не менялось — ничего не двигаем", () => {
  assert.equal(anchorShift([], 4000), 0);
});

/* ------------------------------------------------ спрятанная вкладка */

/**
 * Жалоба: «перехожу к скрипту по cmd+клику из четвёртой ячейки, закрываю,
 * возвращаюсь — тетрадь спустилась к десятой».
 *
 * Числа замерены в Chrome отдельной страницей: у `display: none` контейнера
 * `getBoundingClientRect()` даёт нули, `scrollTop` читается нулём, а после
 * показа браузер сам возвращает прежние 1500. То есть прокрутку теряет не
 * браузер — её увозит наш собственный якорь, если дать ему померить нули.
 */
test("a frame that is not on screen cannot be measured", () => {
  assert.equal(measurable({ top: 0, bottom: 705 }), true);
  // Ровно то, что читается со спрятанной вкладки.
  assert.equal(measurable({ top: 0, bottom: 0 }), false);
  // Вырожденная раскладка: полоса выше контейнера. Мерить тоже нечего.
  assert.equal(measurable({ top: 40, bottom: 12 }), false);
});

test("zero heights from a hidden tab would have moved the screen by the whole notebook", () => {
  /*
   * Что случалось без проверки. Якорь записал всем ячейкам ноль, а при
   * возврате увидел настоящие высоты — и для него это прирост выше экрана.
   * Шесть ячеек по 809 над целью — это 4854 px, четвёртая ячейка против
   * десятой ровно на столько и отличается.
   */
  const asIfGrown = Array.from({ length: 6 }, (_, index) => ({
    top: index * 809,
    delta: 809,
  }));
  assert.equal(anchorShift(asIfGrown, 4854), 4854);
});

/* ------------------------------------------------ ход после запуска */

/** Экран 705 px, тулбар 28 px, как и в остальном файле. */
const ran = { top: 0, bottom: 705, scrollTop: 1000 };

test("a cell whose output already fits is not moved at all", () => {
  assert.equal(afterRun(ran, { top: 200, bottom: 705 - TAIL, toolbar: BAR }), null);
});

test("an output hanging below the fold is brought up, plus room for what follows", () => {
  // Низ на 200 px ниже экрана: подводим его и просвет.
  assert.equal(afterRun(ran, { top: 300, bottom: 905, toolbar: BAR }), 1000 + 200 + TAIL);
});

test("a cell taller than the screen arrives top first, not last line first", () => {
  /*
   * Тот же потолок, что у перехода стрелкой: «низ вывода» у ячейки на три
   * экрана — это её последняя строка, и подвозить её значит увезти код и
   * начало вывода за верхний край.
   */
  assert.equal(afterRun(ran, { top: 400, bottom: 2800, toolbar: BAR }), 1000 + 400 - ROOM);
});

test("running never pulls the sheet upwards", () => {
  // Ячейка выше экрана: «подвести низ» означало бы ход ВВЕРХ — не делаем.
  assert.equal(afterRun(ran, { top: -900, bottom: -100, toolbar: BAR }), null);
});

test("nothing is decided from a hidden tab, running or not", () => {
  const hidden = { top: 0, bottom: 0, scrollTop: 0 };
  assert.equal(afterRun(hidden, { top: 300, bottom: 905, toolbar: BAR }), null);
});

/*
 * За текстовой ячейкой лист идёт так же, как за ячейкой с кодом.
 *
 * За кодом его ведёт смена `runningCellId` у ядра; у заметки ядра нет, и пока
 * она молчала, Shift+Enter вниз по тетради спотыкался на каждой текстовой
 * ячейке: курсор шёл дальше, экран стоял (19.09.2026). Проверка — чтением
 * исходников: заметка говорит сама, Notebook отвечает тем же `follow`.
 */
test("a text cell reports that it settled, and the notebook follows it like a code cell", async () => {
  const { readFileSync } = await import("node:fs");
  const cell = readFileSync(new URL("../web/src/components/notebook/CellView.svelte", import.meta.url), "utf8");
  const book = readFileSync(new URL("../web/src/components/notebook/Notebook.svelte", import.meta.url), "utf8");
  assert.match(
    cell,
    /commitMarkdown\(\)[\s\S]{0,900}?dispatchEvent\(new CustomEvent\('colloq:cell-settled', \{ detail: \{ cellId: id \} \}\)\)[\s\S]{0,40}?return true/,
    "заметка отрисовалась молча — лист за ней не пойдёт",
  );
  assert.match(
    book,
    /addEventListener\('colloq:cell-settled', onSettled\)/,
    "Notebook не слушает отрисовку заметки",
  );
  assert.match(
    book,
    /onSettled = [\s\S]{0,400}?ids\.current\.includes\(cellId\)[\s\S]{0,120}?tick\(\)\.then\(\(\) => follow\(cellId\)\)/,
    "ход за заметкой обязан идти тем же follow и только в своей тетради",
  );
});
