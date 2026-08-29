<script lang="ts">
  /**
   * Папка семинара деревом.
   *
   * Список приходит с сервера уже в том порядке, в каком его рисуют — обход в
   * глубину, папки перед файлами, — так что здесь не строится никакое дерево:
   * строка знает свою глубину из числа косых черт в пути, а свёрнутая папка
   * прячет всё, что под ней. Это и есть причина, по которой сервер отдаёт
   * плоский список: дерево, собранное дважды с двух сторон, — два места, где
   * порядок может разойтись.
   *
   * Нажатие на файл открывает его, а не копирует строку для ячейки: открывать
   * стало чем. Строка для ячейки осталась кнопкой в полосе действий, и она
   * по-прежнему первая — на семинаре по данным её нажимают чаще всего.
   */
  import type { FileEntry } from '@shared/protocol'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { formatBytes, splitFileName } from '@/lib/utils'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import { iconFor } from '@/lib/file-icons'
  import { permitsIn } from '@/lib/may'
  import { baseOf, joinPath, kindOf, parentOf, safeSegment, whySegmentRefused } from '@shared/paths'

  /** One file still on the wire, and the bytes the browser has actually flushed. */
  interface Upload {
    id: number
    name: string
    size: number
    sent: number
  }

  interface Props {
    /** Открыть файл: редактор, читалка или просмотр — решает вызвавший. */
    onopen?: (path: string) => void
    /** Что открыто сейчас — эта строка подсвечена. */
    active?: string | null
    /** Файл переименовали: вкладка на него должна поехать следом. */
    onrename?: (from: string, to: string) => void
  }

  let { onopen, active = null, onrename }: Props = $props()

  const session = getSessionState()

  let dragDepth = $state(0)
  /** Папка, на которую сейчас несут файл. Пустая строка — корень. */
  let dragInto = $state<string | null>(null)
  let uploads = $state<Upload[]>([])
  /** Не ошибка, а предупреждение: загрузка прошла, но что-то заменила собой. */
  let note = $state<string | null>(null)
  let noteTimer: number | undefined
  let error = $state<string | null>(null)
  let copied = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  const isHost = $derived(session.me.role === 'host')
  const may = $derived(permitsIn(session.session.rules, session.me.role))

  /** Свёрнутые папки. Всё, чего здесь нет, развёрнуто: дерево видно целиком. */
  let collapsed = $state<Set<string>>(new Set())
  /** Куда лягут «новый файл» и «новая папка». Пустая строка — корень. */
  let target = $state('')
  /** Строка ввода: заводим новое или переименовываем существующее. */
  let draft = $state<{ kind: 'file' | 'dir' | 'book' | 'rename'; dir: string; from?: string } | null>(
    null,
  )
  let draftName = $state('')
  let draftInput = $state<HTMLInputElement | null>(null)

  const visible = $derived(
    session.files.filter((entry) => {
      for (const folder of collapsed) {
        if (entry.path.startsWith(folder + '/')) return false
      }
      return true
    }),
  )

  const fileCount = $derived(session.files.filter((entry) => !entry.dir).length)
  const listed = $derived(session.files.length > 0 || uploads.length > 0)

  const depthOf = (path: string): number => path.split('/').length - 1

  /**
   * Кто держит этот файл открытым — из присутствия комнаты.
   *
   * Не курсоры: те живут в присутствии самого файла и до комнаты не доходят.
   * Здесь — только «кто здесь», и этого хватает, чтобы не начать править файл,
   * который в этот момент правит сосед, ничего об этом не зная.
   */
  function peersIn(path: string): { id: string; color: string; name: string }[] {
    const out: { id: string; color: string; name: string }[] = []
    for (const peer of session.peers) {
      if (peer.isSelf || peer.user.editing !== path) continue
      if (out.some((seen) => seen.id === peer.user.id)) continue
      out.push({ id: peer.user.id, color: peer.user.color, name: peer.user.name })
    }
    return out.slice(0, 3)
  }

  /** Кнопка 24 пикселя, зазор между ними два; сорок — место под размер файла. */
  const BUTTON = 24
  const GAP = 2
  const SIZE_LANE = 40

  /**
   * Ширина полосы действий — по числу кнопок в строке, а не константой.
   *
   * Действия лежат absolute и в раскладке не участвуют: полоса, рассчитанная на
   * две кнопки, третью выкладывает поверх имени файла. Так это однажды и
   * случилось, когда у PDF появилось «открыть».
   */
  const laneWidth = $derived(
    Math.max(SIZE_LANE, (isHost ? 3 : 2) * BUTTON + ((isHost ? 3 : 2) - 1) * GAP),
  )

  function toggle(path: string): void {
    const next = new Set(collapsed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    collapsed = next
  }

  function pick(entry: FileEntry): void {
    if (entry.dir) {
      target = entry.path
      toggle(entry.path)
      return
    }
    target = parentOf(entry.path)
    // Двоичное не открыть ничем: нажатие на нём означает «дай мне его сюда».
    if (kindOf(entry.path) === 'binary') {
      void download(entry.path)
      return
    }
    onopen?.(entry.path)
  }

  /**
   * Fetch a ticket, then let the browser take the file.
   *
   * The anchor is gone because an anchor could only carry the session token,
   * and that token opens the control socket: a link copied into the group chat
   * handed every reader Restart and Restore under the teacher's name. The
   * ticket in this URL is good for one file for five minutes.
   */
  async function download(path: string): Promise<void> {
    try {
      const { token } = await api.fileTicket(session.session.id, path, session.token)
      const a = document.createElement('a')
      a.href = api.fileUrl(session.session.id, path, token)
      a.download = baseOf(path)
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Не удалось скачать файл.'
    }
  }

  /* ------------------------------------------------------- новое и имена */

  function startDraft(kind: 'file' | 'dir' | 'book'): void {
    draft = { kind, dir: target }
    // У тетради расширение подставлено и выделено не будет: человек набирает
    // имя, а `.ipynb` — не его забота.
    draftName = kind === 'book' ? '.ipynb' : ''
    queueMicrotask(() => {
      draftInput?.focus()
      draftInput?.setSelectionRange(0, 0)
    })
  }

  function startRename(entry: FileEntry): void {
    if (!isHost) return
    draft = { kind: 'rename', dir: parentOf(entry.path), from: entry.path }
    draftName = entry.name
    queueMicrotask(() => {
      draftInput?.focus()
      // Выделено имя без расширения: переименовывают обычно его, а не `.py`.
      const dot = draftName.lastIndexOf('.')
      draftInput?.setSelectionRange(0, dot > 0 ? dot : draftName.length)
    })
  }

  function commitDraft(): void {
    const current = draft
    if (!current) return
    const name = draftName.trim()
    if (!name) return cancelDraft()
    if (!safeSegment(name)) {
      error = whySegmentRefused(name)
      return
    }
    const path = joinPath(current.dir, current.kind === 'book' && !name.endsWith('.ipynb') ? name + '.ipynb' : name)
    if (current.kind === 'rename') {
      if (current.from && current.from !== path) {
        session.send({ t: 'tree:move', from: current.from, to: path })
        onrename?.(current.from, path)
      }
    } else if (current.kind === 'dir') {
      session.send({ t: 'tree:mkdir', path })
    } else if (current.kind === 'book') {
      session.send({ t: 'tree:new', path })
      pendingOpen = path
    } else {
      session.send({ t: 'tree:new', path })
      // Открыть сразу: новый файл заводят, чтобы в него что-то написать, и
      // лишний поиск его же в дереве — это работа на ровном месте.
      pendingOpen = path
    }
    cancelDraft()
  }

  /**
   * Файл, который завели и хотят открыть, как только он появится в списке.
   *
   * Список приходит с сервера, а не сочиняется здесь: открывать файл до того,
   * как сервер подтвердил, что он есть, значило бы открывать вкладку на то,
   * чего может и не оказаться — имя занято, папка исчезла, правило поменялось.
   *
   * `$state`, а не обычная переменная, и это не украшение: эффект ниже читает
   * её первой строкой и на `null` выходит, ничего больше не прочитав. Обычная
   * переменная не была бы его зависимостью — эффект отработал бы один раз при
   * монтировании и не проснулся бы никогда, а файл открывался бы «когда-нибудь
   * потом», то есть при следующей чужой правке.
   */
  let pendingOpen = $state<string | null>(null)

  $effect(() => {
    if (!pendingOpen) return
    const waiting = pendingOpen
    if (!session.files.some((entry) => entry.path === waiting)) return
    pendingOpen = null
    onopen?.(waiting)
  })

  function cancelDraft(): void {
    draft = null
    draftName = ''
  }

  /*
   * A destructive question you cannot back out of with the keyboard is a trap,
   * and this one appears inline in a row rather than in a dialog you can see
   * the edges of. Escape cancels it; a delete already in flight is left alone,
   * because pretending to cancel something the server is doing would be a lie.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (draft) return cancelDraft()
    if (!confirming || deleting) return
    confirming = null
  }
  let deleting = $state<string | null>(null)
  let picker: HTMLInputElement | null = $state(null)
  let copyTimer: number | undefined
  let nextUploadId = 0

  $effect(() => () => window.clearTimeout(copyTimer))

  /** The line a student would actually type to open this file from a cell. */
  function snippetFor(name: string): string {
    const path = `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    switch (ext) {
      case 'csv':
        return `pd.read_csv(${path})`
      case 'tsv':
        return `pd.read_csv(${path}, sep='\\t')`
      case 'jsonl':
      case 'ndjson':
        return `pd.read_json(${path}, lines=True)`
      case 'parquet':
        return `pd.read_parquet(${path})`
      case 'xlsx':
      case 'xls':
        return `pd.read_excel(${path})`
      case 'json':
        return `json.load(open(${path}))`
      case 'npy':
      case 'npz':
        return `np.load(${path})`
      case 'pt':
      case 'pth':
        return `torch.load(${path})`
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'webp':
        return `Image.open(${path})`
      case 'py':
        // Скрипт запускают, а не читают: `%run` — то, что человек на самом деле
        // хочет напечатать в ячейке, когда несёт туда имя файла.
        return `%run ${name}`
      case 'txt':
      case 'md':
        return `open(${path}).read()`
      default:
        return `open(${path}, 'rb').read()`
    }
  }

  function percent(upload: Upload): number {
    // A zero-byte file has nothing to report and is already there by the time
    // the row paints; anything else is a genuine fraction of the payload.
    if (upload.size === 0) return 100
    return Math.min(100, Math.round((upload.sent / upload.size) * 100))
  }

  /*
   * XMLHttpRequest rather than api.uploadFiles(), which is built on fetch —
   * fetch has no upload progress event at all, so a bar driven by it would be
   * an animation rather than a measurement. `xhr.upload.progress` reports bytes
   * handed to the socket, which is the only honest number available here.
   *
   * One request per file, in sequence: a batched multipart body can only report
   * a batch percentage, and the design puts the percentage on the row.
   */
  function put(
    file: File,
    dir: string,
    onSent: (sent: number) => void,
  ): Promise<{ files: FileEntry[]; replaced: string[] }> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      // Папка первой: busboy разбирает части по порядку, и поле, приехавшее
      // после файла, опоздало бы ровно на тот файл, ради которого его послали.
      form.append('dir', dir)
      form.append('file', file, file.name)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/sessions/${session.session.id}/files`)
      xhr.setRequestHeader('authorization', `Bearer ${session.token}`)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onSent(event.loaded)
      }
      xhr.onload = () => {
        let body: { files?: FileEntry[]; replaced?: string[]; error?: string } = {}
        try {
          body = JSON.parse(xhr.responseText) as typeof body
        } catch {
          /* non-JSON error body */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.files) {
          resolve({ files: body.files, replaced: body.replaced ?? [] })
        } else reject(new Error(body.error || xhr.statusText || 'Upload failed'))
      }
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.send(form)
    })
  }

  async function upload(list: FileList | File[] | null, dir: string) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    error = null

    const queued: Upload[] = files.map((file) => ({
      id: nextUploadId++,
      name: file.name,
      size: file.size,
      sent: 0,
    }))
    uploads = [...uploads, ...queued]

    /*
     * Что легло поверх уже лежавшего.
     *
     * Одноимённый файл заменялся молча: человек роняет в комнату свою
     * `data.csv`, а под этим именем уже лежит чужая, на которой в семинаре
     * что-то считают. Отменить это нечем, но и узнавать об этом по числам —
     * слишком поздно. Собирается за весь заход и говорится одной строкой.
     */
    const overwritten: string[] = []

    for (let i = 0; i < files.length; i++) {
      const { id } = queued[i]
      try {
        const done = await put(files[i], dir, (sent) => {
          uploads = uploads.map((item) => (item.id === id ? { ...item, sent } : item))
        })
        session.files = done.files
        overwritten.push(...done.replaced)
      } catch (err) {
        error = err instanceof Error ? err.message : `Не удалось загрузить ${files[i].name}`
      } finally {
        uploads = uploads.filter((item) => item.id !== id)
      }
    }

    if (overwritten.length > 0 && !error) {
      note =
        overwritten.length === 1
          ? `${overwritten[0]} лёг поверх файла, который уже был здесь.`
          : `Поверх уже лежавших легли: ${overwritten.join(', ')}`
      window.clearTimeout(noteTimer)
      noteTimer = window.setTimeout(() => (note = null), 8000)
    }
  }

  function remove(entry: FileEntry): void {
    deleting = entry.path
    error = null
    session.send({ t: 'tree:remove', path: entry.path })
    confirming = null
    // Ответа нет: список файлов приходит комнате целиком, и строка исчезает
    // вместе с ним. Отказ, если он будет, придёт обычной строкой ошибки.
    window.setTimeout(() => (deleting = null), 600)
  }

  async function copySnippet(path: string) {
    try {
      await copyText(snippetFor(path))
      copied = path
      window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied = null), 1400)
    } catch {
      error = 'Браузер не дал доступ к буферу обмена'
    }
  }

  function onDragEnter(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return
    dragDepth += 1
  }

  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return
    // Without preventDefault the browser navigates to the dropped file.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function onDrop(event: DragEvent, dir: string | null) {
    event.preventDefault()
    event.stopPropagation()
    const into = dir ?? ''
    dragDepth = 0
    dragInto = null
    // Сказать до броска нельзя — но и молча съесть файл нельзя тем более:
    // отпущенный файл, о котором ничего не произошло, читается как поломка.
    if (!may.files) {
      error = may.filesWhy + '.'
      return
    }
    void upload(event.dataTransfer?.files ?? null, into)
  }
</script>

<svelte:window onkeydown={onKeydown} />

<section
  class="relative flex shrink-0 flex-col gap-0 px-3 pb-1 pt-5"
  aria-label="Файлы семинара"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={() => (dragDepth = Math.max(0, dragDepth - 1))}
  ondrop={(event) => onDrop(event, '')}
>
  <!-- Полоса уводит заголовок к действиям, так что кнопки читаются как тихий
       конец заголовка, а не как значки, повешенные на него. -->
  <div class="flex items-center gap-2 px-1 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">Файлы</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    {#if may.files}
      <div class="-my-1 -mr-1 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={target ? `Новый файл в ${target}` : 'Новый файл'}
          aria-label="Новый файл"
          onclick={() => startDraft('file')}
        >
          <Icon name="file-plus" size={13} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={target ? `Новая тетрадь в ${target}` : 'Новая тетрадь'}
          aria-label="Новая тетрадь"
          onclick={() => startDraft('book')}
        >
          <Icon name="notebook" size={13} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={target ? `Новая папка в ${target}` : 'Новая папка'}
          aria-label="Новая папка"
          onclick={() => startDraft('dir')}
        >
          <Icon name="folder-plus" size={13} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title="Загрузить файлы"
          aria-label="Загрузить файлы"
          onclick={() => picker?.click()}
        >
          <Icon name="upload" size={13} />
        </button>
      </div>
    {:else if listed}
      <span class="font-mono text-micro tabular-nums text-muted">{fileCount}</span>
    {/if}
  </div>

  <input
    bind:this={picker}
    type="file"
    multiple
    class="hidden"
    onchange={(event) => {
      const input = event.currentTarget
      void upload(input.files, target)
      input.value = ''
    }}
  />

  {#snippet nameField()}
    <input
      bind:this={draftInput}
      bind:value={draftName}
      class="min-w-0 flex-1 border-0 bg-canvas px-1 py-0.5 font-mono text-code text-ink outline-none ring-1 ring-accent/50"
      spellcheck="false"
      autocomplete="off"
      onblur={commitDraft}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitDraft()
        }
      }}
    />
  {/snippet}

  {#each visible as entry (entry.path)}
    {@const depth = depthOf(entry.path)}
    {@const here = peersIn(entry.path)}
    <div
      class="group relative flex h-[26px] items-center transition-colors duration-100
             {active === entry.path ? 'bg-raised' : 'hover:bg-raised focus-within:bg-raised'}
             {dragInto === entry.path ? 'ring-1 ring-inset ring-accent' : ''}"
      style={`padding-left:${4 + depth * 14}px`}
      ondragenter={(event) => {
        if (!entry.dir || !event.dataTransfer?.types.includes('Files')) return
        dragInto = entry.path
      }}
      ondragleave={() => {
        if (dragInto === entry.path) dragInto = null
      }}
      ondrop={(event) => onDrop(event, entry.dir ? entry.path : parentOf(entry.path))}
      role="presentation"
    >
      <!-- Открытый файл отмечен полосой у самого края: она не занимает места в
           строке и видна, даже когда имя ужато до многоточия. -->
      {#if active === entry.path}
        <span class="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden="true"></span>
      {/if}

      <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {#if entry.dir}
          <Icon
            name="chevron-down"
            size={9}
            class={collapsed.has(entry.path) ? '-rotate-90 text-muted' : 'text-muted'}
          />
        {/if}
      </span>
      <span class="flex h-3.5 w-[18px] shrink-0 items-center justify-center">
        <Icon
          name={entry.dir ? 'folder' : iconFor(entry.path)}
          size={12}
          class={active === entry.path ? 'text-ink' : 'text-faint'}
        />
      </span>

      {#if draft?.kind === 'rename' && draft.from === entry.path}
        {@render nameField()}
      {:else}
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center self-stretch text-left font-mono text-code
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                 focus-visible:ring-accent/40
                 {entry.dir
            ? 'font-medium text-ink'
            : active === entry.path
              ? 'font-semibold text-ink'
              : 'text-muted'}"
          title={entry.dir ? entry.path : `${entry.path} — открыть`}
          onclick={() => pick(entry)}
          ondblclick={() => startRename(entry)}
        >
          <span class="truncate">{splitFileName(entry.name).stem}</span>
          <span class="shrink-0">{splitFileName(entry.name).ext}</span>
        </button>

        {#if copied === entry.path}
          <span class="flex shrink-0 items-center gap-1 pr-2 text-2xs font-medium text-positive">
            <Icon name="check" size={11} />
            скопировано
          </span>
        {:else}
          <!--
            Полоса размера — она же полоса действий: обе начинаются в одном
            месте, так что числа стоят колонкой, а действия не наезжают на имя.
            Ширина считается по числу кнопок в ЭТОЙ строке.
          -->
          <div
            class="relative mr-2 flex h-6 shrink-0 items-center justify-end"
            style={`min-width:${entry.dir ? 0 : laneWidth}px`}
          >
            {#if here.length > 0}
              <!-- Кто держит файл открытым. Стоит поверх размера и не прячется
                   под указателем: это то, ради чего на строку и смотрят. -->
              <span class="flex items-center gap-1 pr-0.5">
                {#each here as peer (peer.id)}
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    style={`background:${peer.color}`}
                    title={`${peer.name} — здесь`}
                  ></span>
                {/each}
              </span>
            {:else if !entry.dir}
              <span
                class="whitespace-nowrap font-mono text-micro tabular-nums text-muted transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0"
              >
                {formatBytes(entry.size)}
              </span>
            {/if}
            <span
              class="absolute inset-y-0 right-0 flex items-center gap-0.5 bg-raised opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {#if !entry.dir}
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title={`Скопировать ${snippetFor(entry.path)}`}
                  aria-label="Скопировать строку для ячейки"
                  onclick={() => void copySnippet(entry.path)}
                >
                  <Icon name="copy" size={12} />
                </button>
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title="Скачать"
                  aria-label={`Скачать ${entry.name}`}
                  onclick={() => void download(entry.path)}
                >
                  <Icon name="download" size={12} />
                </button>
              {/if}
              <!-- Убрать файл — преподавательское: папка общая в обе стороны, и
                   раздатка, по которой работает класс, была в одном нажатии от
                   любого. -->
              {#if isHost}
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                  title="Убрать"
                  aria-label={`Убрать ${entry.name}`}
                  onclick={() => (confirming = entry.path)}
                >
                  <Icon name="trash" size={12} />
                </button>
              {/if}
            </span>
          </div>
        {/if}
      {/if}
    </div>

    {#if confirming === entry.path}
      <div
        class="flex h-[26px] items-center gap-2 bg-raised pr-2"
        style={`padding-left:${4 + depth * 14 + 32}px`}
      >
        <span class="min-w-0 flex-1 truncate text-2xs text-muted">
          {entry.dir ? 'Убрать папку со всем, что в ней?' : 'Убрать?'}
        </span>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-danger transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-50"
          disabled={deleting === entry.path}
          onclick={() => remove(entry)}
        >
          {deleting === entry.path ? 'Убираю' : 'Убрать'}
        </button>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={() => (confirming = null)}
        >
          Отмена
        </button>
      </div>
    {/if}
  {/each}

  {#if draft && draft.kind !== 'rename'}
    <!-- Строка ввода стоит там, где файл появится: в выбранной папке, с её
         отступом. Отступ на единицу больше, потому что это её содержимое. -->
    <div
      class="flex h-[26px] items-center pr-2"
      style={`padding-left:${4 + (draft.dir ? depthOf(draft.dir) + 1 : 0) * 14}px`}
    >
      <span class="h-3.5 w-3.5 shrink-0"></span>
      <span class="flex h-3.5 w-[18px] shrink-0 items-center justify-center">
        <Icon
          name={draft.kind === 'dir'
            ? 'folder'
            : draft.kind === 'book'
              ? 'notebook'
              : iconFor(draftName || 'x.txt')}
          size={12}
          class="text-faint"
        />
      </span>
      {@render nameField()}
    </div>
  {/if}

  {#each uploads as item (item.id)}
    {@const done = percent(item)}
    <div class="flex flex-col gap-1 px-2 pb-1 pt-1.5">
      <div class="flex items-center gap-2.5">
        <span class="h-4 w-[3px] shrink-0 bg-brand-2" aria-hidden="true"></span>
        <span class="flex min-w-0 flex-1 font-mono text-code text-muted" title={item.name}>
          <span class="truncate">{splitFileName(item.name).stem}</span>
          <span class="shrink-0">{splitFileName(item.name).ext}</span>
        </span>
        <span
          class="min-w-10 shrink-0 whitespace-nowrap text-right font-mono text-micro tabular-nums text-accent-text"
        >
          {done}%
        </span>
      </div>
      <!-- Scaled, not resized: a width transition would relayout the row on
           every progress event, and only transform is allowed to move. -->
      <div
        class="h-0.5 bg-line"
        role="progressbar"
        aria-label="Загружается {item.name}"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class="h-full origin-left bg-accent"
          style="transform: scaleX({done / 100}); transition: transform var(--speed-quick) linear"
        ></div>
      </div>
    </div>
  {/each}

  <!--
    Есть всегда, в любом состоянии: пустая комната иначе оставалась бы с
    абзацем и без цели.
  -->
  <button
    type="button"
    class="mx-1 mt-2 flex h-9 shrink-0 items-center justify-center border border-dashed text-2xs transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 {dragDepth >
    0
      ? 'border-accent bg-accent/10 text-accent-text'
      : 'border-line text-muted hover:border-faint hover:text-ink'}"
    onclick={() => picker?.click()}
  >
    {target ? `Файлы — в папку ${target}` : 'Файлы — общие с комнатой'}
  </button>

  {#if error}
    <div
      class="mt-1.5 flex items-start gap-2 border-l-2 border-danger px-2 py-1 text-2xs text-danger"
    >
      <span class="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        aria-label="Убрать"
        onclick={() => (error = null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  <!-- Не ошибка: загрузка прошла — но прошла поверх чужого файла, и молчать
       об этом нельзя. Отдельная полоса, потому что цвет здесь другой. -->
  {#if note && !error}
    <div class="mt-1.5 flex items-start gap-2 border-l-2 border-line px-2 py-1 text-2xs text-muted">
      <span class="min-w-0 flex-1 break-words">{note}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70"
        aria-label="Убрать"
        onclick={() => (note = null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  {#if dragDepth > 0 && !listed}
    <!-- Без списка светиться нечему, и панель становится целью сама. Комната,
         где файлы кладёт преподаватель, говорит это прямо здесь: узнать об
         отказе, уже отпустив файл, — то же самое, что не узнать. -->
    <div
      class="pointer-events-none absolute inset-x-4 inset-y-3 flex items-center justify-center border border-dashed text-2xs {may.files
        ? 'border-accent bg-accent/10 text-accent-text'
        : 'border-line bg-surface/80 text-muted'}"
    >
      {may.files ? 'Файлы — общие с комнатой' : may.filesWhy}
    </div>
  {/if}
</section>
