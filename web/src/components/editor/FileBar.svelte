<!--
  Полоса под вкладками, принадлежащая открытому файлу.

  Ровно то же место, где у тетради стоят Run All и Restart: у каждой вкладки
  своя полоса действий, и она всегда под ней. Так вкладка перестаёт быть просто
  переключателем — она называет, чем сейчас занят центр экрана, а полоса под ней
  говорит, что с этим можно сделать.
-->
<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { permitsIn } from '@/lib/may'
  import { runnerFor } from '@shared/paths'

  interface Props {
    path: string
    /** Запускать в этой комнате можно — правило `run`. */
    mayRun: boolean
    /** Править можно — правило `files`. Иначе редактор только читают. */
    mayEdit: boolean
    /** Почему нельзя править, если нельзя. */
    whyReadOnly: string
    /** Сервер не принял правку: дальше документ только читают, что бы ни говорило правило. */
    refused: boolean
    onrun: () => void
  }

  let { path, mayRun, mayEdit, whyReadOnly, refused, onrun }: Props = $props()

  const session = getSessionState()

  /*
   * Право приходит пропсом, а фраза — отсюда: правило `run` объясняется одними
   * и теми же словами в трёх местах (кнопка ячейки, эта кнопка, строка ввода в
   * терминале), и это те слова, которыми отказывает сервер. Своя короткая
   * копия расходилась с ними молча.
   */
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))

  const runner = $derived(runnerFor(path))
  const entry = $derived(session.files.find((file) => file.path === path))

  /**
   * Кто ещё держит этот файл открытым.
   *
   * Из присутствия комнаты, а не из присутствия файла: до второго доходит
   * только тот, у кого файл уже открыт, а сказать об этом надо ровно тому, кто
   * его открывает. Имена, а не точки: здесь есть место на имя, и «Ада правит
   * здесь» — это то, из-за чего человек не начнёт переписывать ту же строку.
   */
  const here = $derived(
    session.peers
      .filter((peer) => !peer.isSelf && peer.user.editing === path)
      .map((peer) => peer.user)
      .filter((user, at, all) => all.findIndex((other) => other.id === user.id) === at)
      .slice(0, 3),
  )

  const savedAt = $derived(
    entry
      ? new Date(entry.modifiedAt).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null,
  )
</script>

<div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
  {#if runner}
    <!--
      Запуск — тот же, что у ячейки: тот же контейнер, тот же Python, та же
      кнопка «прервать» в терминале. Отличается только тем, куда идёт вывод.

      Переход — списком свойств, а не шорткатом `transition`: тот переводит ВСЕ
      свойства, включая border-color и box-shadow фокусного кольца, и кольцо
      приезжало бы вслед за клавишей вместо того, чтобы появиться сразу.
      Двигаются здесь ровно два — brightness под курсором и scale под пальцем;
      полоса рисуется руками и в `.btn` не укладывается (см. index.css · .btn,
      где такой же список стоит позиционно, и близнеца этой кнопки — «На общий
      экран» в SessionScreen).
    -->
    <button
      type="button"
      class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
             transition-[filter,transform] duration-press ease-out
             focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40
             {mayRun
        ? 'bg-primary text-primary-ink enabled:active:scale-[0.97] hover:brightness-110 active:brightness-95'
        : 'cursor-not-allowed bg-surface text-faint'}"
      disabled={!mayRun}
      title={mayRun
        ? `${runner === 'python' ? 'python -u' : 'bash'} ${path} — вывод в терминале`
        : may.runWhy}
      onclick={onrun}
    >
      <Icon name="play" size={11} />
      Запустить
    </button>
  {/if}

  <span class="flex-1"></span>

  <div class="flex shrink-0 items-center gap-2.5 px-5">
    {#if refused || !mayEdit}
      <!--
        Правило важнее отказа, а не наоборот.

        «Правку не приняли» — про правку, которой не было: тому, кто в этой
        комнате и так только читает, сокет отказывает при самом открытии, и
        человек, ничего не напечатавший, получал упрёк вместо правила. Отказ
        называется только там, где печатать было можно.
      -->
      <span class="flex items-center gap-1.5 text-2xs text-muted">
        <Icon name="lock" size={11} />
        {mayEdit ? 'Правка не сохранена. Файл открыт только для чтения' : whyReadOnly}
      </span>
    {:else if savedAt}
      <!-- Время последней записи на диск, а не «есть несохранённое»: файл
           ложится на диск сам через секунду после последнего нажатия, и
           кнопки «сохранить» в этом продукте нет. -->
      <span class="font-mono text-micro tabular-nums text-faint">сохранено · {savedAt}</span>
    {/if}

    {#if here.length > 0}
      <span class="h-3.5 w-px bg-line" aria-hidden="true"></span>
      <span class="flex items-center gap-2">
        {#each here as user (user.id)}
          <span class="flex items-center gap-1.5">
            <span class="h-1.5 w-1.5 rounded-full" style={`background:${user.color}`}></span>
            <span class="text-2xs text-muted">{user.name}</span>
          </span>
        {/each}
        <span class="text-2xs text-faint">здесь</span>
      </span>
    {/if}
  </div>
</div>
