<script lang="ts">
  /**
   * Заглушка списка: строки там, где через миг будут строки.
   *
   * Раньше этот файл звался ContentSkeleton и умел ещё две вещи — «страницу»
   * (шапка и текст) и «тетрадь» (серые ячейки). Обе рисовали НЕ ТО, что
   * загружается: на их месте мог оказаться вход штата вместо панели, пустая
   * тетрадь вместо десяти ячеек, экран отказа вместо всего, — и появлялись они
   * там, где интерфейса ещё не было вовсе, сразу после ухода заставки. Их
   * заменила Splash.svelte, то есть та же заставка, что рисует index.html.
   *
   * Строки списка остались, потому что здесь заглушка не врёт: и панель файлов,
   * и таблица занятий уже нарисованы вокруг, известно, что приедет именно
   * список, и серая строка стоит ровно там, где встанет настоящая, — то есть
   * держит место и не двигает вёрстку под рукой.
   */
  import { tr } from '@shared/i18n'
  import Skeleton from './Skeleton.svelte'

  let { label = tr('common.loading') }: { label?: string } = $props()
</script>

<div role="status" aria-label={label} aria-busy="true" data-skeleton="rows">
  <span class="sr-only">{label}</span>
  <div class="flex flex-col gap-6 py-3">
    {#each ['72%', '55%', '64%', '46%'] as width}
      <div class="flex items-center gap-3">
        <Skeleton width="1.5rem" height="1.5rem" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton {width} height="0.85rem" />
          <Skeleton width="30%" height="0.55rem" />
        </div>
      </div>
    {/each}
  </div>
</div>
