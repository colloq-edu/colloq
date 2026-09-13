/**
 * Две арифметики прокрутки тетради.
 *
 * Обе ломаются молча и обе мерены на стенде, а не выведены из общих
 * соображений: «переход попадает куда попало» и «лист дёргается вверх» — это
 * жалобы с занятия, а не гипотезы. Числа в проверках взяты из того же замера:
 * ячейка 809 px на экране 705, заглушка 240 px, тулбар 28 px.
 */
import "./_env.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceTarget,
  anchorShift,
  BREATH,
  TOOLBAR_FALLBACK,
} from "../web/src/lib/cell-scroll.js";

const BAR = 28;
const ROOM = BAR + BREATH;

test("следующая ячейка встаёт верхом под верх экрана, с местом под тулбар", () => {
  // Экран 705 px от y=100; ячейка начинается на 500 px ниже его верха.
  const target = advanceTarget(
    { top: 100, bottom: 805, scrollTop: 2000 },
    { top: 600, bottom: 1409, toolbar: BAR },
  );
  assert.equal(target, 2000 + 500 - ROOM);
});

test("ячейка ниже экрана приезжает наверх, а не нижним краем к нижнему", () => {
  /*
   * Ровно то, что делал `scrollIntoView({ block: 'nearest' })`: короткая
   * ячейка, начинавшаяся за нижним краем, подъезжала так, чтобы едва влезть, —
   * и человек оказывался в её последней строке.
   */
  const target = advanceTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 780, bottom: 860, toolbar: BAR },
  );
  assert.equal(target, 1000 + 780 - ROOM);
});

test("ячейка выше экрана тоже встаёт под верх, а не впритык", () => {
  // Отрицательный `top` — ячейка начинается над экраном.
  const target = advanceTarget(
    { top: 0, bottom: 705, scrollTop: 3000 },
    { top: -120, bottom: 689, toolbar: BAR },
  );
  assert.equal(target, 3000 - 120 - ROOM);
});

test("ячейка, которая и так вся на экране вместе с тулбаром, экран не двигает", () => {
  assert.equal(
    advanceTarget(
      { top: 0, bottom: 705, scrollTop: 1000 },
      { top: 200, bottom: 400, toolbar: BAR },
    ),
    null,
  );
});

test("тулбар за верхним краем — это уже не «вся на экране»", () => {
  /*
   * Тулбар висит НАД ячейкой и в её прямоугольник не входит. Ячейка, чей верх
   * стоит в двух пикселях от края, видна целиком — а ряд с «запустить» уже
   * срезан, и именно к нему сейчас потянутся.
   */
  const target = advanceTarget(
    { top: 0, bottom: 705, scrollTop: 1000 },
    { top: 2, bottom: 300, toolbar: BAR },
  );
  assert.equal(target, 1000 + 2 - ROOM);
});

test("выше начала листа не увозим", () => {
  assert.equal(
    advanceTarget(
      { top: 0, bottom: 705, scrollTop: 5 },
      { top: -5, bottom: 900, toolbar: BAR },
    ),
    0,
  );
});

test("пиксель разницы — не повод для кадра анимации", () => {
  // Ячейка уже стоит там, куда её повезли бы: ход был бы дрожью, а не ходом.
  assert.equal(
    advanceTarget(
      { top: 0, bottom: 705, scrollTop: 1000 },
      { top: ROOM + 0.5, bottom: 2000, toolbar: BAR },
    ),
    null,
  );
});

test("высота тулбара у непостроенной ячейки — запасное число, а не ноль", () => {
  // Место под тулбар нужно и тогда, когда самого тулбара в DOM ещё нет.
  assert.ok(TOOLBAR_FALLBACK > 0);
  const target = advanceTarget(
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
