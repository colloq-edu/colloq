<script lang="ts">
  /**
   * Заставка приложения: марка по центру и полоска под ней.
   *
   * Та же картинка, что рисует `#boot` в `web/index.html`, и это главное её
   * свойство. Оболочка уходит, а заставка остаётся стоять на её месте — в тех
   * же координатах, того же размера, с той же анимацией, — так что для
   * человека это ОДНА непрерывная заставка, а не две сменившие друг друга.
   * Поэтому числа ниже — копия тамошних, и правятся они парой: в index.html
   * стоит указатель сюда, здесь — туда.
   *
   * Почему копия, а не общий файл: `#boot` рисуется до того, как приедет CSS
   * приложения (лист грузится неблокирующе, см. vite.config.ts), поэтому свои
   * токены `--boot-*` и своя разметка у него неизбежны. Марка при этом
   * рисуется одним и тем же набором клеток — здесь через `Icon name="logo"`,
   * там тем же SVG руками.
   *
   * Заменяет скелет «страницы» и «тетради»: серая вёрстка обещает конкретный
   * экран и появляется до того, как хоть что-то из него известно, — а
   * заставка обещает только «идёт загрузка», что и есть правда.
   */
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /**
     * `screen` — вместо целого экрана: ровно там же, где стоял `#boot`.
     * `pane` — внутри уже нарисованного интерфейса (область тетради в
     * комнате, тело страницы в читалке): тише и мельче, чтобы не спорить с
     * тем, что вокруг неё уже есть.
     */
    size?: 'screen' | 'pane'
    label?: string
  }

  let { size = 'screen', label = tr('common.loading') }: Props = $props()

  // Марка мельче на панели по той же причине, по которой полоска короче:
  // вложенная заставка не может быть крупнее той, что стоит вместо экрана.
  const MARK = { screen: 28, pane: 20 } as const
</script>

<!--
  `role="status"` с `aria-busy` — то же, что у `#boot` и у скелетов, которые
  эта заставка сменила: экран читалки объявляет «Загрузка…» один раз и не
  поминутно, пока идёт ожидание.
-->
<div
  class="splash {size}"
  data-splash={size}
  role="status"
  aria-label={label}
  aria-busy="true"
>
  <div class="mark">
    <Icon name="logo" size={MARK[size]} />
    <span class="bar" aria-hidden="true"></span>
  </div>
</div>

<style>
  /*
   * ЧИСЛА — КОПИЯ #boot ИЗ web/index.html. Марка 28, полоска 88×2, зазор 16,
   * появление 0.25s с задержкой 0.25s, пробег 1.1s ease-in-out. Разъехавшись,
   * они дадут скачок ровно в то мгновение, когда оболочка уходит, — то самое,
   * ради чего эту заставку и завели.
   */
  .splash {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(var(--canvas));
  }

  /*
   * Экранная — fixed, а не «на всю родительскую коробку»: она обязана встать
   * в тот же центр окна, что и `#boot`, независимо от того, в какой ветке
   * разметки её поставили. z-index ниже оболочки (999): пока та не ушла, эта
   * стоит под ней и её не видно.
   */
  .screen {
    position: fixed;
    inset: 0;
    z-index: 30;
  }

  /*
   * Панельная — обычный блок в потоке. Потолок высоты снизу, чтобы область не
   * схлопнулась в полоску: 240 px — это примерно первая ячейка тетради, то
   * есть столько места, сколько всё равно займёт то, что грузится.
   */
  .pane {
    width: 100%;
    height: 100%;
    min-height: 240px;
  }

  .mark {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    color: rgb(var(--ink));
    opacity: 0;
    /* Загрузка быстрее четверти секунды не должна показывать ничего: мигнувшая
       заставка читается как заминка, а не как ожидание. */
    animation: splash-in 0.25s ease 0.25s forwards;
  }
  @keyframes splash-in {
    to {
      opacity: 1;
    }
  }

  .bar {
    display: block;
    position: relative;
    overflow: hidden;
    width: 88px;
    height: 2px;
    border-radius: 999px;
    background: rgb(var(--line));
  }
  .pane .bar {
    width: 64px;
  }
  .bar::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 40%;
    border-radius: inherit;
    background: rgb(var(--accent));
    transform: translateX(-100%);
    animation: splash-sweep 1.1s ease-in-out infinite;
  }
  @keyframes splash-sweep {
    to {
      transform: translateX(250%);
    }
  }

  /* Как в `#boot`: бегущего акцента нет вовсе, остаётся тихая полоса — и
     появляется она сразу, потому что гасить нечего. */
  @media (prefers-reduced-motion: reduce) {
    .mark {
      animation-delay: 0s;
    }
    .bar::after {
      width: 100%;
      transform: none;
      animation: none;
      opacity: 0.4;
    }
  }
</style>
