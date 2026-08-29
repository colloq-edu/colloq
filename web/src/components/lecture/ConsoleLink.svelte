<!--
  Ссылка, которой преподаватель отдаёт свой пульт планшету.

  Лекцию ведут с айпада — страницу листают пальцем, пишут Pencil'ом, — а
  ноутбук у проектора остаётся показывать. Чтобы планшет стал пультом, он
  должен войти в комнату ТЕМ ЖЕ человеком: иначе в списке появится второй
  «Ада», а вести лекцию по правилу `board` будет некому.

  Вводить имя и пароль на планшете нечего — их в этом продукте нет вовсе.
  Поэтому ссылка: короткоживущий ключ на обмен (десять минут, один раз), и о
  том, что он пускает в комнату ВАМИ, здесь сказано прямо. Не токен: тем же
  адресом нельзя ни открыть сокет, ни скачать файл.

  Кнопка «Поделиться» — не украшение: с макбука это ровно тот системный лист,
  из которого ссылка уезжает на планшет по AirDrop одним касанием. Где листа
  нет, остаётся буфер обмена, и она молча становится «скопировать».
-->
<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { copyText } from '@/lib/clipboard'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    /** Как выглядит кнопка в своей полосе — классы у полос разные. */
    class?: string
  }

  let { class: className = '' }: Props = $props()

  const session = getSessionState()

  let open = $state(false)
  let busy = $state(false)
  let link = $state<string | null>(null)
  let minutes = $state(10)
  let failure = $state<string | null>(null)
  let copied = $state(false)

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  async function ask(): Promise<void> {
    if (busy) return
    busy = true
    failure = null
    try {
      const res = await api.handoff(session.session.id, session.token)
      link = `${location.origin}/s/${session.session.id}/t/${res.key}`
      minutes = Math.max(1, Math.round(res.livesMs / 60_000))
      open = true
    } catch (cause: unknown) {
      failure = cause instanceof Error ? cause.message : 'Ссылку сделать не удалось.'
      open = true
    } finally {
      busy = false
    }
  }

  async function copy(): Promise<void> {
    if (!link) return
    try {
      await copyText(link)
      copied = true
      setTimeout(() => (copied = false), 1600)
    } catch {
      // Буфер обмена может быть закрыт политикой браузера. Ссылка на экране —
      // и есть запасной ход: её видно целиком и она выделяется одним нажатием.
      failure = 'Браузер не дал скопировать. Ссылка на экране — выделите её.'
    }
  }

  async function share(): Promise<void> {
    if (!link) return
    try {
      await navigator.share({ title: 'Пульт лекции', url: link })
    } catch {
      // Лист закрыли, ничего не выбрав, — это не ошибка и говорить о ней нечего.
    }
  }
</script>

<span class="relative flex items-stretch">
  <button
    type="button"
    class={className}
    aria-expanded={open}
    title="Ссылка, по которой ваш планшет станет пультом лекции"
    onclick={() => (open ? (open = false) : void ask())}
  >
    <Icon name={busy ? 'spinner' : 'link'} size={12} class={busy ? 'animate-spin' : ''} />
    Пульт
  </button>

  {#if open}
    <!-- Ниже полосы и от правого края: полоса узкая, а панель шире её кнопки. -->
    <div
      class="absolute right-0 top-full z-40 mt-px w-[min(24rem,calc(100vw-1.5rem))] border border-line bg-raised p-3 text-left shadow-pop"
      role="dialog"
      aria-label="Пульт на планшет"
    >
      {#if failure}
        <p class="text-ui leading-snug text-danger">{failure}</p>
      {:else}
        <p class="pb-2 text-2xs leading-snug text-muted">
          Откройте это на планшете — он войдёт в комнату вами и станет пультом.
          Ссылка живёт {minutes} минут и пускает сюда КЕМ УГОДНО как вас: она для
          своего устройства, не для чата.
        </p>
        <p
          class="select-all break-all border border-line bg-canvas px-2 py-1.5 font-mono text-2xs text-ink"
        >
          {link}
        </p>
      {/if}
      <div class="flex items-center gap-1.5 pt-2">
        {#if link && canShare}
          <button type="button" class="btn-primary h-7 px-2.5 text-2xs" onclick={() => void share()}>
            Поделиться
          </button>
        {/if}
        {#if link}
          <button type="button" class="btn-outline h-7 px-2.5 text-2xs" onclick={() => void copy()}>
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          class="btn-ghost h-7 px-2.5 text-2xs"
          onclick={() => void ask()}
          disabled={busy}
        >
          Обновить
        </button>
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          aria-label="Закрыть"
          onclick={() => (open = false)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  {/if}
</span>
