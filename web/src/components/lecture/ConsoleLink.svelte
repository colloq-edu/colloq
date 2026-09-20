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

  ОДНА НА ДВА ПУЛЬТА. Пульт консилиума отдают телефону тем же движением и с тем
  же ключом — разного в них ровно три вещи: хвост адреса (ячейка вместо
  лекции), слово на кнопке и то, ЧЕМ эта ссылка опасна. Поэтому здесь не проп
  «куда вести», а проп «какой пульт»: слова про чужие работы обязаны стоять
  рядом со ссылкой, которая их открывает, и оторваться от неё не должны.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { copyText } from '@/lib/clipboard'
  import { getSessionState } from '@/lib/session.svelte'
  import { seminarLink } from '@/lib/seminar-link'

  interface Props {
    /** Как выглядит кнопка в своей полосе — классы у полос разные. */
    class?: string
    /**
     * Ячейка пульта консилиума. `null` — пульт лекции, один на комнату.
     *
     * Он же решает и слова: за ссылкой консилиума лежат чужие работы целиком, и
     * сказать об этом обязано то же место, что выдаёт ссылку.
     */
    cellId?: string | null
    /** Подпись у кнопки; значок стоит всегда. `false` — только значок. */
    caption?: boolean
  }

  let { class: className = '', cellId = null, caption = true }: Props = $props()

  const session = getSessionState()
  const council = $derived(cellId !== null)
  /** Хвост за `/s/:id` — тот же разбор, что в lib/routes.ts. */
  const tail = $derived(council ? `/council/${cellId}` : '/pult')

  let open = $state(false)
  let anchor = $state<HTMLButtonElement | null>(null)
  /**
   * Где стоит панель — считается от кнопки и зажимается в окно.
   *
   * Была `absolute right-0`, то есть «правым краем по правому краю кнопки», и
   * на 390 px это уводило её за ЛЕВУЮ кромку экрана: панель шире 360, а кнопка
   * стоит в середине полосы. С телефона тогда не прочитать ни предупреждения,
   * ни самой ссылки — ровно того, ради чего панель и открывают. `fixed` ещё и
   * не режется прокручиваемой полосой, в которой кнопка живёт.
   */
  let at = $state<{ left: number; top: number; width: number } | null>(null)
  const GAP = 12
  function place(): void {
    const box = anchor?.getBoundingClientRect()
    if (!box) return
    const width = Math.min(384, window.innerWidth - GAP * 2)
    at = {
      width,
      left: Math.max(GAP, Math.min(box.right - width, window.innerWidth - width - GAP)),
      top: Math.min(box.bottom + 1, Math.max(GAP, window.innerHeight - GAP)),
    }
  }
  let busy = $state(false)
  let link = $state<string | null>(null)
  let minutes = $state(10)
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  let copied = $state(false)

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  async function ask(): Promise<void> {
    if (busy) return
    busy = true
    failureRender = () => (null)
    try {
      const res = await api.handoff(session.session.id, session.token)
      // Не от адресной строки: комнату чаще всего ведут с localhost, и такую
      // ссылку планшет не откроет вовсе. Из двух адресов выбирает то же
      // правило, что и в панели (seminar-link.ts), а хвост экрана и `/t/<ключ>`
      // дописываются к готовому `<origin>/s/<id>`.
      link = `${seminarLink(res.origin, location.origin, session.session.id)}${tail}/t/${res.key}`
      minutes = Math.max(1, Math.round(res.livesMs / 60_000))
      place()
      open = true
    } catch (cause: unknown) {
      // И прежний ключ с экрана убираем: он уже мог быть потрачен, а отказ над
      // живой на вид ссылкой — это два противоположных утверждения разом.
      link = null
      failureRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.142'))
      place()
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
      // Поэтому отказ рисуется НАД ссылкой, а не вместо неё (см. разметку):
      // совет выделить ссылку, которую он же и убрал, — это тупик.
      failureRender = () => (tr('room.ui.143'))
    }
  }

  async function share(): Promise<void> {
    if (!link) return
    try {
      await navigator.share({ get title() { return tr(council ? 'room.pult.v3.shareTitle' : 'room.ui.144') }, url: link })
    } catch {
      // Лист закрыли, ничего не выбрав, — это не ошибка и говорить о ней нечего.
    }
  }
</script>

<span class="relative flex items-stretch">
  <button
    type="button"
    bind:this={anchor}
    class={className}
    aria-expanded={open}
    aria-label={tr(council ? 'room.pult.v3.toPhone' : 'room.ui.133')}
    data-console-link={council ? 'council' : 'lecture'}
    title={tr(council ? 'room.pult.v3.toPhoneHint' : 'room.ui.132')}
    onclick={() => (open ? (open = false) : void ask())}
  >
    <Icon name={busy ? 'spinner' : 'link'} size={12} class={busy ? 'animate-spin' : ''} />{#if caption} {tr(council ? 'room.pult.v3.toPhone' : 'room.ui.133')} {/if}</button>

  {#if open && at}
    <!-- Под кнопкой и в пределах окна: см. `place`. -->
    <div
      class="fixed z-40 border border-line bg-raised p-3 text-left shadow-pop"
      style={`left:${at.left}px; top:${at.top}px; width:${at.width}px`}
      role="dialog"
      aria-label={tr(council ? 'room.pult.v3.shareTitle' : 'room.ui.134')}
    >
      <!--
        Отказ и ссылка — два независимых блока, а не ветки одного. Отказ
        копирования говорит «ссылка на экране — выделите её», и пока это была
        ветка `{:else}`, он же эту ссылку с экрана и убирал: оставались две
        кнопки, одна из которых упадёт снова, и «Обновить», сжигающий ключ.
      -->
      {#if failure}
        <p class="pb-2 text-ui leading-snug text-danger">{failure}</p>
      {/if}
      {#if link}
        <!--
          «До первого открытия» здесь можно обещать: сервер гасит ключ первым же
          обменом (auth.ts, `spendHandoffToken`), так что десять минут — верхний
          предел, а не окно, в котором ссылка ждёт всех подряд. Пока сервер ключ
          не гасил, три места в продукте говорили «годится один раз», и ни одно
          не было правдой.
        -->
        <p class="pb-2 text-2xs leading-snug text-muted"> {tr('room.ui.135')} {minutes} {tr('room.ui.136')} </p>
        <!--
          И чем эта ссылка опасна — своими словами, а не общим «не отправляйте
          другим». Пульт консилиума за одним адресом держит весь класс целиком:
          имена, черновики, ошибки и отметки. Тот же довод уже стоит на отказе
          не-преподавателю внутри пульта (PultWindow · room.ui.1358), и говорить
          его в двух местах по-разному нельзя.
        -->
        {#if council}
          <p class="pb-2 text-2xs leading-snug text-warning" data-console-link-danger>
            {tr('room.pult.v3.shareDanger')}
          </p>
        {/if}
        <p
          class="select-all break-all border border-line bg-canvas px-2 py-1.5 font-mono text-2xs text-ink"
        >
          {link}
        </p>
      {/if}
      <div class="flex items-center gap-1.5 pt-2">
        {#if link && canShare}
          <button type="button" class="btn-primary h-7 px-2.5 text-2xs" onclick={() => void share()}> {tr('room.ui.137')} </button>
        {/if}
        {#if link}
          <button type="button" class="btn-outline h-7 px-2.5 text-2xs" onclick={() => void copy()}>
            {copied ? tr('room.ui.138') : tr('room.ui.139')}
          </button>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          class="btn-ghost h-7 px-2.5 text-2xs"
          onclick={() => void ask()}
          disabled={busy}
        > {tr('room.ui.140')} </button>
        <button
          type="button"
          class="btn-ghost h-7 w-7 px-0"
          aria-label={tr('room.ui.141')}
          onclick={() => (open = false)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  {/if}
</span>
