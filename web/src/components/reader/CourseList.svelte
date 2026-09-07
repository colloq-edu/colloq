<!--
  Страница курса — единственный адрес Colloq, который человек сохраняет в
  закладки. Один семинар в строку, в том порядке, в каком их вели.

  Документ, а не афиша: одна колонка, тонкие линейки, никаких карточек. Смотрят
  на неё двенадцать раз за семестр, и каждый раз ищут одну строку.
-->
<script lang="ts">
  import { plural } from '@/lib/plural'
  import type { PublicCourseView } from '@shared/publish'

  interface Props {
    course: PublicCourseView
    onnavigate: (path: string) => void
  }

  let { course, onnavigate }: Props = $props()

  const shortDate = (at: number): string =>
    new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

  /* «Одна страница» словом — так же, как в окне публикации; дальше числом.
     Правило множественного числа общее: своё врало на 11 и на 21. */
  const steps = (n: number): string =>
    n === 1 ? 'одна страница' : `${n} ${plural(n, 'шаг', 'шага', 'шагов')}`

  /* Тот же адрес, что и на выгруженной странице курса: имя, если его выбрали. */
  const href = (pub: { id: string; slug: string | null }): string => `/p/${pub.slug ?? pub.id}`
</script>

<!-- Стрелка строки, по которой можно пройти. Один раз, потому что таких строк
     две: живой семинар и закрытая комната с оставшимся чтением. -->
{#snippet chevron()}
  <span class="w-4 shrink-0 text-accent" aria-hidden="true">
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
      <path
        d="M1 1L6 6L1 11"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
{/snippet}

<div class="min-h-screen bg-canvas px-6 pb-16 pt-16 sm:pt-24">
  <div class="mx-auto w-full max-w-[760px]">
    <h1 class="text-marquee-sm font-black leading-none tracking-tight text-ink sm:text-marquee">
      {course.name}
    </h1>
    {#if course.blurb}
      <p class="mt-3.5 max-w-[560px] text-ui-lg leading-relaxed text-muted">{course.blurb}</p>
    {/if}
    <!--
      Тот же адрес, что диктуют вслух и печатают на выгруженной странице.

      Здесь стоял `course.id` — восемь случайных букв, — хотя имя курса у вида
      есть, панель копирует и диктует именно его (admin/screens/Courses.svelte),
      а статическая страница печатает `slug ?? id` (publish/render.ts). Работают
      оба адреса, но «сохраните эту страницу» под строкой, которой не было на
      доске, читается как чужая.
    -->
    <p class="mt-4 font-mono text-2xs text-muted">
      {location.host}/c/{course.slug ?? course.id}
    </p>

    <ol class="mt-11 border-t border-line">
      {#each course.items as item, index (index)}
        {@const ordinal = String(index + 1).padStart(2, '0')}
        {#if item.kind === 'gone' && item.publication}
          <!--
            Надгробие, за которым осталось чтение: удаление семинара по
            умолчанию сохраняет опубликованную страницу — ссылку у студентов не
            отозвать. Без этой строки-ссылки страница жива и открывается по
            прямому адресу, а с курса — единственного адреса, который классу
            вообще дают, — до неё не дойти.
          -->
          {@const closed = item.publication}
          <li class="border-b border-line">
            <button
              class="flex w-full items-baseline gap-6 py-5 text-left transition-colors duration-100 hover:bg-surface/70"
              onclick={() => onnavigate(href(closed))}
            >
              <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
              <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
              <span class="shrink-0 text-ui text-muted">комната закрыта, страница осталась</span>
              {@render chevron()}
            </button>
          </li>
        {:else if item.kind === 'gone'}
          <!-- Надгробие. Строка остаётся: курс, из которого молча пропала
               четвёртая неделя, сломан для того, кто на ней сидел, а номера
               остальных уезжают и перестают совпадать с расписанием. -->
          <li class="flex items-baseline gap-6 border-b border-line py-5">
            <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
            <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
            <span class="shrink-0 text-ui text-muted">семинар удалён</span>
            <span class="w-4 shrink-0"></span>
          </li>
        {:else if item.kind === 'seminar' && item.publication}
          {@const publication = item.publication}
          <li class="border-b border-line">
            <button
              class="flex w-full items-baseline gap-6 py-5 text-left transition-colors duration-100 hover:bg-surface/70"
              onclick={() => onnavigate(href(publication))}
            >
              <span class="w-[34px] shrink-0 font-mono text-ui text-muted">{ordinal}</span>
              <span class="min-w-0 flex-1 text-title font-semibold text-ink">{item.name}</span>
              <span class="shrink-0 text-ui text-muted">
                {shortDate(publication.publishedAt)} · {steps(publication.steps)}
              </span>
              {@render chevron()}
            </button>
          </li>
        {:else if item.kind === 'planned'}
          <!--
            Тема, которую ещё не вели. Строка нужна, чтобы страница курса была
            планом семестра с первой недели: иначе в сентябре она пуста, а
            завести тридцать комнат вперёд — это тридцать ссылок в пустые
            тетради за три месяца до занятия.
          -->
          <li class="flex items-baseline gap-6 border-b border-line py-5">
            <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
            <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
            <span class="shrink-0 whitespace-nowrap text-ui text-faint">{item.when}</span>
            <span class="w-4 shrink-0"></span>
          </li>
        {:else}
          <li class="flex items-baseline gap-6 border-b border-line py-5">
            <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
            <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
            <span class="shrink-0 text-ui text-muted">ещё не опубликован</span>
            <span class="w-4 shrink-0"></span>
          </li>
        {/if}
      {/each}
    </ol>

    <!--
      Обещание, а не подпись. В первую неделю на странице одна строка, и эта
      фраза несёт её целиком: иначе курс из одного семинара читается как
      сломанный.
    -->
    <p class="mt-9 text-ui text-muted">
      Каждый семинар курса появляется здесь — по мере того, как их проводят.
      Сохраните эту страницу.
    </p>
  </div>
</div>
