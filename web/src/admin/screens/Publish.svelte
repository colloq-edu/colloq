<!--
  Публикация семинара.

  Экран, а не окно поверх списка: у панели на это своё правило — «всё, что
  требует решения, получает собственный экран». Здесь решают, что класс будет
  читать неделю спустя, и обратно это не отзывается — ссылку у студентов не
  забрать.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { AdminApiError, addressHolderOf, adminApi } from '@/lib/adminApi'
  import { skippedStepLine } from '@/admin/panel'
  import { plural } from '@/lib/plural'
  import {
    MAX_STEP_LABEL,
    slugOk,
    suggestSlug,
    type AddressHolder,
    type PublishCandidate,
    type SkippedStep,
  } from '@shared/publish'

  interface Props {
    sessionId: string
    navigate: (path: string) => void
  }

  /** Ответ `publishInfo` целиком — чтобы форму страницы не переписывать здесь второй раз. */
  type PublishInfo = Awaited<ReturnType<typeof adminApi.publishInfo>>

  let { sessionId, navigate }: Props = $props()

  let title = $state('')
  let candidates = $state<PublishCandidate[]>([])
  /**
   * Уже опубликованная страница — ровно та форма, что приезжает в ответе.
   *
   * Своего объявления у экрана больше нет. Оно завелось ради `former` (прежних
   * имён в адресе): сервер их вёз, а тип вызова о них не знал, и экран описал
   * страницу второй раз, чтобы отпустить прежнее имя было чем. Теперь поле
   * стоит в `lib/adminApi.ts` (publishInfo · former), и копия здесь — только
   * лишний шанс разойтись с сервером на следующем поле.
   */
  let already = $state<PublishInfo['publication']>(null)
  /** Отмеченные шаги и их имена — по номеру версии. */
  let labels = $state<Record<number, string>>({})
  let picked = $state<Record<number, boolean>>({})
  let error = $state<string | null>(null)
  let busy = $state(false)
  let done = $state<string | null>(null)
  /**
   * Отмеченные моменты, которые шагами не стали, — с сервера, поимённо.
   *
   * Ответ несёт их отдельным полем (shared/publish.ts · SkippedStep) как раз
   * потому, что раньше их не было нигде: пустая или нечитаемая версия молча
   * выпадала из публикации, и семь отмеченных превращались в шесть шагов без
   * единого слова о том, какой пропал.
   */
  let skipped = $state<SkippedStep[]>([])

  onMount(() => {
    void adminApi
      .publishInfo(sessionId)
      .then((body) => {
        title = body.title
        candidates = body.candidates
        already = body.publication
        /*
         * Прежние имена — с сервера, а не только те, что переименовали в этой
         * вкладке. Страницу переименовывают в понедельник, а адрес освобождают
         * в сентябре следующего года: до сих пор список был пуст у всех, кто
         * просто открыл экран, и отпускать в нём было нечего.
         */
        former = already?.former ?? []
        /*
         * Действующий адрес — с сервера, а не придуманный заново.
         *
         * Экран его не знал вовсе: после повторной публикации он подставлял
         * предложение из названия и держал кнопку «Дать имя адресу» активной,
         * так что одно нажатие меняло адрес, продиктованный классу неделю
         * назад, — а старое имя после этого не находил никто.
         */
        slug = body.publication?.slug ?? ''
        slugDraft = slug
        /*
         * Названные моменты отмечены сразу — их для того и называли. Безымянные
         * не отмечены и отмечены быть не могут, пока в поле не напишут слова:
         * «Снимок №14» в рельсе у студента не название момента, а признание,
         * что назвать его забыли.
         */
        const previous = new Map(body.publication?.steps.map((s) => [s.seq, s.label]) ?? [])
        for (const candidate of body.candidates) {
          const label = previous.get(candidate.seq) ?? candidate.label
          labels[candidate.seq] = label
          picked[candidate.seq] = label.length > 0
        }
      })
      .catch((cause) =>
        (error = cause instanceof AdminApiError ? cause.message : 'Не удалось загрузить историю семинара. Попробуйте обновить страницу.'),
      )
  })

  const chosen = $derived(
    candidates.filter((c) => picked[c.seq] && (labels[c.seq] ?? '').trim().length > 0),
  )
  /** Один момент — значит будет одна страница. В первом семестре это обычное. */
  const lone = $derived(candidates.length === 0)

  async function publish(): Promise<void> {
    busy = true
    error = null
    try {
      const body = await adminApi.publish(
        sessionId,
        chosen.map((c) => ({ seq: c.seq, label: labels[c.seq].trim(), at: c.at })),
      )
      done = body.publication.id
      skipped = body.skipped ?? []
      // Повторная публикация адрес сохраняет — показываем тот, что есть.
      slug = body.publication.slug ?? slug
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'Не удалось опубликовать семинар. Попробуйте ещё раз.'
    } finally {
      busy = false
    }
  }

  /** Имя в адресе, выбранное человеком. Предлагается из названия семинара. */
  let slug = $state('')
  let slugDraft = $state('')
  $effect(() => {
    if (done && !slugDraft) slugDraft = suggestSlug(title)
  })

  /**
   * Имена, под которыми эта страница уже жила.
   *
   * Сервер прежнее имя помнит: `setPublicationSlug` кладёт его в
   * `publish_addresses`, и `findPublication` находит страницу по нему
   * (server/src/publish/store.ts · moveAddress, findPublication). Раньше здесь
   * стоял confirm, обещавший обратное — «адрес /p/week-01 перестанет
   * открываться», — и преподаватель либо отказывался от переименования из-за
   * несуществующей угрозы, либо шёл передиктовывать классу адрес, который и
   * так работает.
   *
   * Список приходит с ответом о публикации и пополняется здешними
   * переименованиями: экран, открытый год спустя, знает ровно то же, что и
   * сервер, — иначе отпускать в нём было бы нечего.
   */
  let former = $state<string[]>([])

  /**
   * Страница, о которой идёт речь: только что опубликованная или уже жившая.
   *
   * Прежние имена принадлежат ЕЙ, а не сегодняшнему нажатию «Опубликовать»:
   * отпускает их владелец, и идентификатор владельца — вот он.
   */
  const pageId = $derived(done ?? already?.id ?? null)

  /**
   * Имя, которого не дали, и кто его держит.
   *
   * Отказ «уже занят» бывает двух совсем разных сортов. Живой адрес чужой
   * страницы — тупик: освободить его может только её владелец. А прежнее имя,
   * оставленное ради розданной ссылки, отпускается — и отпустить его вправе тот,
   * чьё оно (server/src/publish/store.ts · releaseFormerSlug). Пока сервер
   * держателя не называет, здесь остаётся null и экран ведёт себя как раньше:
   * повторяет фразу отказа и ничего не предлагает.
   */
  let held = $state<{ slug: string; holder: AddressHolder } | null>(null)
  /** Второй шаг: отпустить прежний адрес — необратимо, и спрашивается вслух. */
  let asking = $state(false)

  async function saveSlug(): Promise<void> {
    if (!done || busy) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      error = 'Адрес: 3–64 символа, строчные латинские буквы, цифры и дефис. Первый и последний символ — буква или цифра.'
      return
    }
    busy = true
    error = null
    held = null
    try {
      await adminApi.setSlug('publication', done, next || null)
      // Прежнее имя остаётся адресом, новое перестаёт быть чьим-то прежним —
      // тем же движением, что и на сервере.
      const was = slug
      slug = next
      former = [...new Set([...former, was].filter((name) => name && name !== next))]
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'Не удалось сохранить адрес. Попробуйте ещё раз.'
      const holder = addressHolderOf(cause)
      // Только прежнее: живой адрес отсюда не отпускают, его снимают именем.
      if (holder?.former && next) held = { slug: next, holder }
    } finally {
      busy = false
    }
  }

  /**
   * Освободить прежний адрес и занять его — одним решением.
   *
   * Одним, потому что отпускают его ровно затем, чтобы дать это имя своей
   * странице: два нажатия подряд оставили бы посередине состояние «имя ничьё»,
   * в котором его может занять кто угодно другой.
   */
  async function release(): Promise<void> {
    if (!held || busy) return
    const { holder, slug: freed } = held
    busy = true
    error = null
    try {
      await adminApi.releaseFormerSlug(holder.kind, holder.id, freed)
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'Не удалось освободить прежний адрес. Попробуйте ещё раз.'
      return
    } finally {
      busy = false
    }
    held = null
    asking = false
    slugDraft = freed
    await saveSlug()
  }

  /**
   * Освободить своё прежнее имя.
   *
   * Другое действие, чем выше, хотя маршрут тот же: там имя забирают себе,
   * здесь — просто отпускают. Единственное, что случится наверняка, — ссылка с
   * этим адресом перестанет открываться, и вернуть её нечем; поэтому второй
   * шаг, и цена названа и у кнопки, и в вопросе.
   */
  let dropping = $state<string | null>(null)

  async function dropFormer(): Promise<void> {
    const page = pageId
    const name = dropping
    if (!page || !name || busy) return
    busy = true
    error = null
    try {
      await adminApi.releaseFormerSlug('publication', page, name)
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'Не удалось освободить прежний адрес. Попробуйте ещё раз.'
      return
    } finally {
      busy = false
    }
    former = former.filter((was) => was !== name)
    dropping = null
  }

  const stamp = (at: number): string =>
    new Date(at).toLocaleString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'long',
    })

  /** Чем назвать момент, которого нет на странице: временем из ленты версий. */
  const momentOf = (seq: number): string | undefined => {
    const candidate = candidates.find((c) => c.seq === seq)
    return candidate ? stamp(candidate.at) : undefined
  }

  /** Escape закрывает вопрос — но не посреди ответа сервера. */
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || busy) return
    if (asking) asking = false
    else if (dropping) dropping = null
  }

  const YES = 'M1 5.2L4.6 8.8L12 1.4'
  const NO = 'M1.6 1.6L11.4 11.4M11.4 1.6L1.6 11.4'
  const FACT = 'flex items-center gap-3.5 border-b border-line-soft px-3.5 py-2 last:border-b-0'
</script>

<svelte:window onkeydown={onKey} />

<!--
  Прежние адреса страницы — списком, и с ними можно что-то сделать.

  Переименование не отменяет розданную ссылку: старое имя остаётся адресом этой
  страницы навсегда — и держит его для всех остальных тоже, так что странице
  следующего года это имя уже не дать. Отпускает его владелец, по одному, и
  цена названа прямо над кнопкой, а не только в вопросе после неё: ссылка,
  записанная в чате прошлогодней группы, перестаёт открываться.

  Один сниппет на оба места (страница только что опубликована — и страница,
  которая была опубликована раньше): список прежних имён один и тот же, а два
  куска разметки разошлись бы на первой же правке слов.
-->
{#snippet formerNames()}
  {#if former.length > 0}
    <div class="border-t border-line pt-3">
      <p class="text-ui font-semibold text-ink">Прежние адреса</p>
      <p class="mt-0.5 text-2xs leading-snug text-muted">
        Эти ссылки открывают текущую публикацию. Если освободить адрес, он перестанет вести сюда
        и его сможет занять другая публикация.
      </p>
      <div class="mt-2 flex flex-col">
        {#each former as name (name)}
          <div class="flex items-center gap-3 border-b border-line-soft py-1.5 last:border-b-0">
            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">/p/{name}</span>
            <button
              type="button"
              class="btn-outline h-7 shrink-0 px-3 text-2xs"
              disabled={busy}
              onclick={() => (dropping = name)}
            >
              Освободить
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

<AdminPage
  title={done ? 'Опубликовано' : `Опубликовать — ${title}`}
  subtitle={done
    ? 'Повторная публикация обновляет страницу по той же ссылке.'
    : already
      ? `Опубликован ранее — /p/${already.slug ?? already.id}. Публикуя снова, вы оставляете ту же ссылку.`
      : 'Выберите версии тетради для публикации.'}
>
  {#snippet actions()}
    <button type="button" class="btn-ghost" onclick={() => navigate('/admin')}>
      {done ? 'К списку' : 'Отмена'}
    </button>
    {#if !done}
      <button type="button" class="btn-primary" disabled={busy} onclick={() => void publish()}>
        Опубликовать
      </button>
    {/if}
  {/snippet}

  <div class="px-8 py-6">
    {#if error}
      <p class="pb-4 text-ui text-danger">{error}</p>
    {/if}

    {#if done}
      <div class="flex max-w-[640px] flex-col gap-3 border border-line bg-surface p-5">
        <p class="text-ui text-muted">Опубликованная страница:</p>
        <a
          class="block font-mono text-ui-lg text-accent-text"
          href={`/p/${slug || done}`}
          target="_blank"
          rel="noreferrer"
        >
          {location.host}/p/{slug || done}
        </a>
        <!--
          Адрес диктуют вслух и пишут на доске: восемь случайных символов
          запоминаются хуже, чем «week-05», и переспрашивают их чаще. Старый
          адрес продолжает работать — ссылку, которую уже дали, ломать нельзя.
        -->
        <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span class="font-mono text-2xs text-muted">{location.host}/p/</span>
          <input
            class="h-7 w-[220px] border border-line bg-canvas px-2 font-mono text-2xs text-ink
                   placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder={done}
            maxlength={64}
            bind:value={slugDraft}
            onkeydown={(event) => {
              if (event.key === 'Enter') void saveSlug()
            }}
          />
          <button
            type="button"
            class="btn-primary h-7 px-3 text-2xs"
            disabled={busy || slugDraft.trim() === slug}
            onclick={() => void saveSlug()}
          >
            {slug ? 'Изменить адрес' : 'Задать адрес'}
          </button>
          <!-- Имя держит не живая страница, а память о розданной ссылке — и
               это единственный вид «занято», который владелец может разрешить
               сам. Кнопка стоит здесь же, у поля: искать её в другом месте
               экрана значит не найти вовсе. -->
          {#if held}
            <button
              type="button"
              class="btn-outline h-7 px-3 text-2xs"
              disabled={busy}
              onclick={() => (asking = true)}
            >
              Освободить прежний адрес
            </button>
          {/if}
          <!-- Идентификатор ведёт сюда всегда: кто продиктовал классу /p/xxxx
               до того, как у страницы появилось имя, переспрашивать не должен.
               Прежние ИМЕНА — ниже, отдельным списком: с ними можно ещё и
               что-то сделать. -->
          {#if slug}
            <span class="text-2xs text-muted">старый адрес /p/{done} тоже работает</span>
          {/if}
        </div>

        {#if held}
          <p class="text-2xs leading-snug text-muted">
            <span class="font-mono text-ink">/p/{held.slug}</span> — прежний адрес страницы
            {#if held.holder.name}«{held.holder.name}»{/if}. После переноса эта ссылка будет открывать
            текущую публикацию вместо прежней.
          </p>
        {/if}

        {@render formerNames()}
      </div>

      <!--
        Что отмечали, но чего на странице не будет.

        Ниже ссылки и отдельным блоком: ссылка — это результат, а это оговорка
        к нему, и молчать о ней нельзя. Раньше её не было вовсе — семь
        отмеченных моментов превращались в шесть шагов, и преподаватель
        пересчитывал рельсу глазами.
      -->
      {#if skipped.length > 0}
        <div class="mt-4 max-w-[640px] border-l-[3px] border-warning bg-surface px-4 py-3">
          <p class="text-ui font-semibold text-ink">
            {skipped.length}
            {plural(skipped.length, 'момент', 'момента', 'моментов')}
            {plural(skipped.length, 'пропущен', 'пропущены', 'пропущены')}
          </p>
          <ul class="mt-1.5 flex flex-col gap-1">
            {#each skipped as step (`${step.seq}:${step.reason}`)}
              <li class="text-ui leading-relaxed text-muted">
                {skippedStepLine(step, momentOf(step.seq))}
              </li>
            {/each}
          </ul>
          <p class="mt-2 text-2xs leading-snug text-faint">
            Остальные шаги опубликованы. После устранения причины можно повторить публикацию
            по той же ссылке.
          </p>
        </div>
      {/if}
    {:else}
      <!-- Шаги -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 border-b border-line pb-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">Шаги</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            Сохранённые версии тетради с кодом, заметками и выводом ячеек.
          </p>
        </div>

        {#if lone}
          <!--
            Единственное место в продукте, где вообще объясняется, зачем нажимать
            «Чекпоинт». В первом семестре это будет обычный случай: чекпоинтов
            никто не ставил, потому что никто не говорил, для чего они.
          -->
          <div class="min-w-0 flex-1 border border-line bg-surface px-5 py-4">
            <p class="text-ui-lg font-semibold text-ink">
              Нет сохранённых версий для выбора. Будет опубликована текущая тетрадь.
            </p>
            <p class="mt-2 text-ui leading-relaxed text-muted">
              Шаги берутся из чекпоинтов. Нажмите <span class="font-semibold text-ink">«Чекпоинт»</span>
              в ленте версий, чтобы сохранить тетрадь на нужном этапе занятия.
              Например, перед упражнением или после разбора решения.
            </p>
          </div>
        {:else}
          <div class="min-w-0 flex-1 border border-line">
            {#each candidates as candidate (candidate.seq)}
              {@const named = (labels[candidate.seq] ?? '').trim().length > 0}
              <div
                class="flex items-center gap-3.5 border-b border-line-soft px-4 py-2.5 last:border-b-0"
                class:bg-surface={!named}
              >
                <button
                  type="button"
                  class="flex h-[15px] w-[15px] shrink-0 items-center justify-center border
                         {picked[candidate.seq] && named
                    ? 'border-brand bg-brand text-white'
                    : 'border-faint bg-canvas'}"
                  aria-pressed={picked[candidate.seq] && named}
                  aria-label="Включить версию в публикацию"
                  disabled={!named}
                  onclick={() => (picked[candidate.seq] = !picked[candidate.seq])}
                >
                  {#if picked[candidate.seq] && named}
                    <svg width="9" height="7" viewBox="0 0 13 10" fill="none">
                      <path
                        d={YES}
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  {/if}
                </button>
                <span class="w-[128px] shrink-0 font-mono text-2xs text-muted">
                  {stamp(candidate.at)}
                </span>
                <span class="w-[86px] shrink-0 font-mono text-2xs text-faint">
                  {candidate.cellCount} ячеек
                </span>
                {#if named}
                  <input
                    class="min-w-0 flex-1 border border-transparent bg-transparent px-2 py-1 text-ui text-ink
                           hover:border-line focus:border-line focus:outline-none"
                    maxlength={MAX_STEP_LABEL}
                    bind:value={labels[candidate.seq]}
                  />
                {:else}
                  <input
                    class="min-w-0 flex-1 border border-line bg-canvas px-2 py-1 text-ui text-ink
                           placeholder:text-faint focus:outline-none"
                    placeholder="Название версии"
                    maxlength={MAX_STEP_LABEL}
                    bind:value={labels[candidate.seq]}
                    oninput={() => (picked[candidate.seq] = true)}
                  />
                {/if}
              </div>
            {/each}

            <!-- Последняя страница есть всегда: публикация без неё была бы
                 рассказом о занятии, обрывающимся на середине. -->
            <div class="flex items-center gap-3.5 border-t border-line bg-surface px-4 py-2.5">
              <span class="flex h-[15px] w-[15px] shrink-0 items-center justify-center bg-faint text-white">
                <svg width="9" height="7" viewBox="0 0 13 10" fill="none">
                  <path d={YES} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="w-[128px] shrink-0 font-mono text-2xs text-muted">сейчас</span>
              <span class="w-[86px] shrink-0"></span>
              <span class="min-w-0 flex-1 px-2 text-ui text-muted">
                Тетрадь на момент публикации
                <span class="pl-2 text-2xs text-faint">всегда включается в публикацию</span>
              </span>
            </div>
          </div>
        {/if}
      </div>

      <!-- Что станет публичным -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 border-b border-line py-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">Что станет публичным</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            Имена и личные данные в тексте ячеек или их выводе сохранятся. Проверьте их перед публикацией.
          </p>
        </div>
        <div class="min-w-0 flex-1 border border-line bg-surface">
          {#each [['Ячейки, их код и заметки', 'такими, какими были на каждом шаге'], ['Всё, что ячейки напечатали', 'графики, таблицы, трейсбеки'], ['Кнопка «скопировать» у каждой ячейки и вся тетрадь файлом .ipynb', 'чтобы код можно было забрать']] as [what, why] (what)}
            <div class={FACT}>
              <svg width="13" height="10" viewBox="0 0 13 10" fill="none" class="shrink-0">
                <path d={YES} stroke="#1B7A4B" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="min-w-0 flex-1 text-ui text-ink">{what}</span>
              <span class="w-[300px] shrink-0 text-2xs text-muted">{why}</span>
            </div>
          {/each}
          {#each [['Кто что печатал и кто что запускал', 'авторство действий не публикуется'], ['Лента вопросов к оракулу', 'вопросы и ответы не публикуются'], ['Терминал', 'история команд не публикуется'], ['Файлы комнаты', 'файлы не включаются в публикацию']] as [what, why] (what)}
            <div class="{FACT} border-t border-line">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" class="shrink-0">
                <path d={NO} stroke="#8E2334" stroke-width="1.7" stroke-linecap="round" />
              </svg>
              <span class="min-w-0 flex-1 text-ui text-ink">{what}</span>
              <span class="w-[300px] shrink-0 text-2xs text-muted">{why}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Ссылка -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 py-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">Ссылка</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">Поделитесь ссылкой со студентами.</p>
        </div>
        <div class="flex min-w-0 max-w-[700px] flex-1 flex-col gap-3">
          {#if already}
            <!-- Тот же адрес, что и в подзаголовке: заданное имя И ЕСТЬ ссылка,
                 которую дали классу, а идентификатор рядом с ним читается как
                 второй адрес той же страницы. -->
            <p class="font-mono text-ui-lg text-ink">
              {location.host}/p/{already.slug ?? already.id}
            </p>
            <!-- И здесь тоже: страницу, опубликованную в прошлом семестре,
                 сюда открывают как раз затем, чтобы разобраться с её адресами,
                 а не затем, чтобы опубликовать её заново. -->
            {@render formerNames()}
          {/if}
          <p class="text-ui leading-relaxed text-muted">
            Повторная публикация сохраняет ссылку. После снятия публикации по ней отображается
            сообщение об этом. Страница содержит запрет индексации для поисковых систем.
          </p>
          <div class="border-l-[3px] border-warning bg-surface px-4 py-3">
            <p class="text-ui leading-relaxed text-muted">
              <span class="font-semibold text-ink">Доступ к комнате не меняется.</span>
              Публикация и архивация не меняют доступ по ссылке <span class="font-mono">/s/{sessionId}</span>.
              Вход и редактирование зависят от действующих правил комнаты и статуса занятия.
            </p>
          </div>
        </div>
      </div>
    {/if}
  </div>
</AdminPage>

<!--
  Освободить прежний адрес — вопросом, а не нажатием.

  Единственное необратимое действие на этом экране: ссылка, которую уже
  продиктовали классу, после этого отвечает 404, и вернуть её нечем. Поэтому
  второй шаг — и цена в нём названа тем же адресом, который стоит в чате
  группы, а не словами «связанные данные».
-->
{#if asking && held}
  {@const going = held}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="release-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="release-slug-title" class="text-title font-semibold text-ink">
        Освободить адрес /p/{going.slug}?
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        Сейчас он ведёт на страницу
        {#if going.holder.name}«{going.holder.name}»{/if}. После переноса эта ссылка будет
        открывать текущую публикацию вместо прежней.
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (asking = false)}>
          Отмена
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void release()}
        >
          {busy ? 'Переносим…' : 'Перенести адрес'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Освободить своё прежнее имя — тот же вопрос, но имя никто не ждёт.

  Здесь его отпускают не затем, чтобы занять: оно освобождается для всех, и
  единственное, что случится наверняка, — ссылка с ним перестанет открываться.
  Поэтому и слова другие, и глагол на кнопке другой.
-->
{#if dropping}
  {@const going = dropping}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="drop-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="drop-slug-title" class="text-title font-semibold text-ink">
        Освободить адрес /p/{going}?
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        Эта ссылка перестанет открывать текущую публикацию. Адрес сможет занять другая
        публикация, и тогда ссылка будет вести на неё.
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (dropping = null)}>
          Отмена
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void dropFormer()}
        >
          {busy ? 'Освобождаем…' : 'Освободить адрес'}
        </button>
      </div>
    </div>
  </div>
{/if}
