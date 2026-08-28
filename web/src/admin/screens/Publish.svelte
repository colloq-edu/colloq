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
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import {
    MAX_STEP_LABEL,
    slugOk,
    suggestSlug,
    type PublishCandidate,
  } from '@shared/publish'

  interface Props {
    sessionId: string
    navigate: (path: string) => void
  }

  let { sessionId, navigate }: Props = $props()

  let title = $state('')
  let candidates = $state<PublishCandidate[]>([])
  let already = $state<{ id: string; steps: { seq: number; label: string; at: number }[] } | null>(
    null,
  )
  /** Отмеченные шаги и их имена — по номеру версии. */
  let labels = $state<Record<number, string>>({})
  let picked = $state<Record<number, boolean>>({})
  let error = $state<string | null>(null)
  let busy = $state(false)
  let done = $state<string | null>(null)

  onMount(() => {
    void adminApi
      .publishInfo(sessionId)
      .then((body) => {
        title = body.title
        candidates = body.candidates
        already = body.publication
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
        (error = cause instanceof AdminApiError ? cause.message : 'не удалось прочитать историю'),
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
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'не удалось опубликовать'
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

  async function saveSlug(): Promise<void> {
    if (!done) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      error = 'Только строчные латинские буквы, цифры и дефис — адрес диктуют вслух.'
      return
    }
    busy = true
    error = null
    try {
      await adminApi.setSlug('publication', done, next || null)
      slug = next
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'адрес не сохранился'
    } finally {
      busy = false
    }
  }

  const stamp = (at: number): string =>
    new Date(at).toLocaleString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'long',
    })

  const YES = 'M1 5.2L4.6 8.8L12 1.4'
  const NO = 'M1.6 1.6L11.4 11.4M11.4 1.6L1.6 11.4'
  const FACT = 'flex items-center gap-3.5 border-b border-line-soft px-3.5 py-2 last:border-b-0'
</script>

<AdminPage
  title={done ? 'Опубликовано' : `Опубликовать — ${title}`}
  subtitle={done
    ? 'Ссылка постоянная: публикуя снова, вы оставляете её той же.'
    : already
      ? `Опубликован ранее. Публикуя снова, вы оставляете ту же ссылку.`
      : 'Пока вы не нажали «Опубликовать», публичного ничего нет.'}
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
        <p class="text-ui text-muted">Страница класса:</p>
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
            Дать имя адресу
          </button>
        </div>
      </div>
    {:else}
      <!-- Шаги -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 border-b border-line pb-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">Шаги</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            Моменты, по которым пойдёт студент. Каждый показывает тетрадь такой, какой она была,
            вместе с выводами.
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
              В этом семинаре один момент — значит будет одна страница.
            </p>
            <p class="mt-2 text-ui leading-relaxed text-muted">
              Шаги берутся из чекпоинтов. Нажмите <span class="font-semibold text-ink">«Чекпоинт»</span>
              в ленте версий прямо на занятии, когда класс дошёл до чего-то, к чему стоит вернуться, —
              «перед упражнением», «версия, которая ломалась», — и это станут шаги, по которым
              студенты пойдут.
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
                  aria-label="Взять этот момент"
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
                    placeholder="назовите этот момент"
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
                <span class="pl-2 text-2xs text-faint">снять нельзя — это последняя страница</span>
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
            И что не станет — списком, а не мелким шрифтом.
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
          {#each [['Кто что печатал и кто что запускал', 'ничьих имён на странице нет'], ['Лента вопросов к оракулу', 'в ней имена всех, кто спрашивал'], ['Терминал', 'в расшифровке оболочки может быть что угодно'], ['Файлы комнаты', 'код студенты читают, запускать его негде']] as [what, why] (what)}
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
          <p class="mt-0.5 text-2xs leading-snug text-muted">Её и надо дать классу.</p>
        </div>
        <div class="flex min-w-0 max-w-[700px] flex-1 flex-col gap-3">
          {#if already}
            <p class="font-mono text-ui-lg text-ink">{location.host}/p/{already.id}</p>
          {/if}
          <p class="text-ui leading-relaxed text-muted">
            Постоянная. Повторная публикация её не меняет; если снять страницу, ссылка остаётся и
            говорит, что вы её сняли. В поисковиках не показывается.
          </p>
          <div class="border-l-[3px] border-warning bg-surface px-4 py-3">
            <p class="text-ui leading-relaxed text-muted">
              <span class="font-semibold text-ink">Комната остаётся открытой.</span>
              Любой, у кого есть <span class="font-mono">/s/{sessionId}</span>, по-прежнему зайдёт в
              неё и сможет печатать. Архивация убирает семинар из вашего списка и тоже её не
              запирает.
            </p>
          </div>
        </div>
      </div>
    {/if}
  </div>
</AdminPage>
