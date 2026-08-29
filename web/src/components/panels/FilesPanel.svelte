<script lang="ts">
  import type { FileEntry } from '@shared/protocol'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { formatBytes, splitFileName } from '@/lib/utils'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import { permitsIn } from '@/lib/may'

  /** One file still on the wire, and the bytes the browser has actually flushed. */
  interface Upload {
    id: number
    name: string
    size: number
    sent: number
  }

  interface Props {
    /** Открыть документ: у преподавателя — комнате, у остальных — себе. */
    onopen?: (name: string) => void
  }

  let { onopen }: Props = $props()

  const session = getSessionState()

  let dragDepth = $state(0)
  let uploads = $state<Upload[]>([])
  /** Не ошибка, а предупреждение: загрузка прошла, но что-то заменила собой. */
  let note = $state<string | null>(null)
  let noteTimer: number | undefined
  let error = $state<string | null>(null)
  let copied = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  const isHost = $derived(session.me.role === 'host')
  const may = $derived(permitsIn(session.session.rules, session.me.role))

  /*
   * По расширению, а не по MIME: в списке файлов комнаты MIME нет, а
   * запрашивать его на каждую строку — запрос на файл ради одной иконки.
   */
  const isPdf = (name: string): boolean => name.toLowerCase().endsWith('.pdf')

  /**
   * Fetch a ticket, then let the browser take the file.
   *
   * The anchor is gone because an anchor could only carry the session token,
   * and that token opens the control socket: a link copied into the group chat
   * handed every reader Restart and Restore under the teacher's name. The
   * ticket in this URL is good for one file for five minutes.
   */
  async function download(name: string): Promise<void> {
    try {
      const { token } = await api.fileTicket(session.session.id, name, session.token)
      const a = document.createElement('a')
      a.href = api.fileUrl(session.session.id, name, token)
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not download that file.'
    }
  }

  /*
   * A destructive question you cannot back out of with the keyboard is a trap,
   * and this one appears inline in a row rather than in a dialog you can see
   * the edges of. Escape cancels it; a delete already in flight is left alone,
   * because pretending to cancel something the server is doing would be a lie.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !confirming) return
    if (deleting) return
    confirming = null
  }
  let deleting = $state<string | null>(null)
  let picker: HTMLInputElement | null = $state(null)
  let copyTimer: number | undefined
  let nextUploadId = 0

  const listed = $derived(session.files.length > 0 || uploads.length > 0)

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
      case 'txt':
      case 'md':
      case 'py':
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
    onSent: (sent: number) => void,
  ): Promise<{ files: FileEntry[]; replaced: string[] }> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
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

  async function upload(list: FileList | File[] | null) {
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
        const done = await put(files[i], (sent) => {
          uploads = uploads.map((item) => (item.id === id ? { ...item, sent } : item))
        })
        session.files = done.files
        overwritten.push(...done.replaced)
      } catch (err) {
        error = err instanceof Error ? err.message : `Could not upload ${files[i].name}`
      } finally {
        uploads = uploads.filter((item) => item.id !== id)
      }
    }

    if (overwritten.length > 0 && !error) {
      note =
        overwritten.length === 1
          ? `${overwritten[0]} replaced a file that was already here.`
          : `${overwritten.length} files replaced ones that were already here: ${overwritten.join(', ')}`
      window.clearTimeout(noteTimer)
      noteTimer = window.setTimeout(() => (note = null), 8000)
    }
  }

  async function remove(name: string) {
    deleting = name
    error = null
    try {
      const res = await api.deleteFile(session.session.id, name, session.token)
      session.files = res.files
      confirming = null
    } catch (err) {
      error = err instanceof Error ? err.message : `Could not delete ${name}`
    } finally {
      deleting = null
    }
  }

  async function copySnippet(name: string) {
    try {
      await copyText(snippetFor(name))
      copied = name
      window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied = null), 1400)
    } catch {
      error = 'The browser blocked clipboard access'
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

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragDepth = 0
    // Сказать до броска нельзя — но и молча съесть файл нельзя тем более:
    // отпущенный файл, о котором ничего не произошло, читается как поломка.
    if (!may.files) {
      error = may.filesWhy + '.'
      return
    }
    upload(event.dataTransfer?.files ?? null)
  }
</script>

<svelte:window onkeydown={onKeydown} />

<section
  class="relative flex shrink-0 flex-col gap-0.5 px-4 pb-1 pt-5"
  aria-label="Session files"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={() => (dragDepth = Math.max(0, dragDepth - 1))}
  ondrop={onDrop}
>
  <!-- The rule carries the label out to the count, so the number reads as the
       quiet end of the heading rather than as a badge hung off it. -->
<div class="flex items-center gap-2 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">Files</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    {#if listed}
      <span class="font-mono text-micro tabular-nums text-muted">{session.files.length}</span>
    {:else if may.files}
      <!-- Nothing to count yet, so the slot carries the way in instead. -->
      <button
        type="button"
        class="-my-1 -mr-1 flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        title="Upload files"
        aria-label="Upload files"
        onclick={() => picker?.click()}
      >
        <Icon name="upload" size={14} />
      </button>
    {/if}
  </div>

  <input
    bind:this={picker}
    type="file"
    multiple
    class="hidden"
    onchange={(event) => {
      const target = event.currentTarget
      upload(target.files)
      target.value = ''
    }}
  />

  {#if listed}
    {#each session.files as file (file.name)}
      <div
        class="group flex h-[30px] items-center gap-2.5 px-2 transition-colors duration-100 hover:bg-raised focus-within:bg-raised"
      >
        <!-- Every row carries a tick on the rail; under the pointer it becomes
             the action colour, which is what says the row is live. -->
        <span
          class="h-4 w-[3px] shrink-0 bg-line transition-colors duration-100 group-hover:bg-primary group-focus-within:bg-primary"
          aria-hidden="true"
        ></span>

        {#if confirming === file.name}
          <span class="min-w-0 flex-1 truncate text-2xs text-muted">Delete {file.name}?</span>
          <button
            type="button"
            class="shrink-0 text-2xs font-bold uppercase tracking-caps text-danger transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-50"
            disabled={deleting === file.name}
            onclick={() => remove(file.name)}
          >
            {deleting === file.name ? 'Deleting' : 'Delete'}
          </button>
          <button
            type="button"
            class="shrink-0 text-2xs font-bold uppercase tracking-caps text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onclick={() => (confirming = null)}
          >
            Cancel
          </button>
        {:else}
          <!-- The row's ground and its tick already say the row is live, so the
               name keeps its ink: the lane stays a column of files rather than
               becoming a column of links. -->
          <!--
            Two spans, not one truncated string. `truncate` was on the button
            itself, which is a flex container — and `text-overflow` does nothing
            on one, so long names were cut with no ellipsis and no extension at
            all. The stem shrinks and the extension never does, so `.npz` and
            `.md` stay told apart at any panel width, and the full name is still
            one hover away.
          -->
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center self-stretch text-left font-mono
                   text-code text-ink focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-accent/40"
            title={`${file.name} — copy ${snippetFor(file.name)}`}
            onclick={() => copySnippet(file.name)}
          >
            <span class="truncate">{splitFileName(file.name).stem}</span>
            <span class="shrink-0">{splitFileName(file.name).ext}</span>
          </button>

          {#if copied === file.name}
            <span class="flex shrink-0 items-center gap-1 text-2xs font-medium text-positive">
              <Icon name="check" size={11} />
              copied
            </span>
          {:else}
            <!-- The size lane is the actions lane: both start at the same 40px
                 so the numbers stay in one column down the list, and the lane
                 grows rather than wrapping when a size runs long. Actions stay
                 in the DOM so they can be tabbed to; only their opacity hides. -->
            <div class="relative flex h-6 min-w-10 shrink-0 items-center justify-end">
              <span
                class="whitespace-nowrap font-mono text-micro tabular-nums text-muted transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0"
              >
                {formatBytes(file.size)}
              </span>
              <span
                class="absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <!--
                  Открыть PDF, не выходя из комнаты. У преподавателя — сразу
                  всем: право `board` про общий экран, а не про чтение, и
                  смотреть у себя может любой. Клик по имени не трогаем: он
                  копирует питоновский сниппет, и это уже привычка.
                -->
                {#if isPdf(file.name)}
                  <button
                    type="button"
                    class="flex h-6 w-6 items-center justify-center text-faint transition-colors
                           duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-accent/40"
                    title={may.board ? 'Показать комнате' : 'Открыть у себя'}
                    aria-label="Открыть {file.name}"
                    onclick={() => onopen?.(file.name)}
                  >
                    <Icon name="board" size={13} />
                  </button>
                {/if}
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors
                         duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
                         focus-visible:ring-accent/40"
                  title="Download"
                  aria-label="Download {file.name}"
                  onclick={() => void download(file.name)}
                >
                  <Icon name="download" size={13} />
                </button>
                <!-- Removing a file is the teacher's: the folder is shared in
                     both directions, and the handout the class is working from
                     sat one click from anybody. -->
                {#if isHost}
                  <button
                    type="button"
                    class="flex h-6 w-6 items-center justify-center text-faint transition-colors
                           duration-100 hover:text-danger focus-visible:outline-none
                           focus-visible:ring-2 focus-visible:ring-danger/40"
                    title="Delete"
                    aria-label="Delete {file.name}"
                    onclick={() => (confirming = file.name)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                {/if}
              </span>
            </div>
          {/if}
        {/if}
      </div>
    {/each}

    {#each uploads as item (item.id)}
      {@const done = percent(item)}
      <div class="flex flex-col gap-1 px-2 pb-1 pt-1.5">
        <div class="flex items-center gap-2.5">
          <span class="h-4 w-[3px] shrink-0 bg-brand-2" aria-hidden="true"></span>
          <!-- Same rule while it is still going up: the extension is what the
               room is looking for in the list. -->
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
          aria-label="Uploading {item.name}"
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

  {/if}

  <!--
    Always here, in every state. It used to appear only once a file existed,
    which left an empty room with a paragraph and no target — and the artboard
    draws the dashed zone whether the list is full or not.
  -->
  <button
    type="button"
    class="mt-1.5 flex h-9 shrink-0 items-center justify-center border border-dashed text-2xs transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 {dragDepth >
    0
      ? 'border-accent bg-accent/10 text-accent-text'
      : 'border-line text-muted hover:border-faint hover:text-ink'}"
    onclick={() => picker?.click()}
  >
    Drop files — shared with the room
  </button>


  {#if error}
    <div class="mt-1.5 flex items-start gap-2 border-l-2 border-danger px-2 py-1 text-2xs text-danger">
      <span class="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        aria-label="Dismiss"
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
        aria-label="Dismiss"
        onclick={() => (note = null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  {#if dragDepth > 0 && !listed}
    <!-- With no list there is no drop zone to light up, so the panel becomes one.
         Комната, где файлы кладёт преподаватель, говорит это прямо здесь: узнать
         об отказе, уже отпустив файл, — то же самое, что не узнать. -->
    <div
      class="pointer-events-none absolute inset-x-4 inset-y-3 flex items-center justify-center border border-dashed text-2xs {may.files
        ? 'border-accent bg-accent/10 text-accent-text'
        : 'border-line bg-surface/80 text-muted'}"
    >
      {may.files ? 'Drop files — shared with the room' : may.filesWhy}
    </div>
  {/if}
</section>
