<script lang="ts" module>
  /**
   * The image's `pip freeze` as a file: offered by the panel's window only,
   * the competition pages pass nothing and their window stays as it was.
   * The words are the panel's (admin.env.freeze*), which is why only the panel
   * may pass this.
   */
  export interface EnvironmentFreeze {
    /** The route answering `<name>-pip-freeze.txt`, or words when it cannot. */
    endpoint: string
    /** An image is there to read: false for an environment never built. */
    built: boolean
    /** The release catalog's pinned image, which this server has no docker to run; null otherwise. */
    catalogImage: string | null
  }

  /** An image is here for the server to read: built on this machine, and not the release catalog's. */
  export function freezeReadable(freeze: EnvironmentFreeze | undefined): freeze is EnvironmentFreeze {
    return freeze !== undefined && freeze.built && freeze.catalogImage === null
  }

  /** What one press of the download came to. */
  export type FreezePress =
    /** No image to read: nothing was asked. */
    | { done: 'skipped' }
    /** The route's 200, handed to the browser as `<name>-pip-freeze.txt`. */
    | { done: 'saved' }
    /** Anything else: the server's words, or null when it gave none and the window says its own. */
    | { done: 'refused'; words: string | null }
    /** The window closed under it: nothing to save and nobody to tell. */
    | { done: 'aborted' }

  /**
   * One press, with the page's effects passed in (the window passes the real
   * ones), so the suite holds it to its promises without a browser
   * (tests/environments-freeze.test.mts): nothing is asked when there is no
   * image to read, only a 200 becomes a file, and a refusal is words. A 409
   * or a 503 saved as `<name>-pip-freeze.txt` would be a JSON error under a
   * requirements name, and `pip install -r` would choke on it later, on
   * somebody's laptop.
   */
  export async function pressFreeze(
    name: string,
    freeze: EnvironmentFreeze | undefined,
    page: { fetch: typeof fetch; save: (file: Blob, filename: string) => void; signal: AbortSignal },
  ): Promise<FreezePress> {
    if (!freezeReadable(freeze)) return { done: 'skipped' }
    const { fetch: ask, save, signal } = page
    try {
      const response = await ask(freeze.endpoint, { credentials: 'include', signal })
      if (response.status !== 200) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null
        return { done: 'refused', words: typeof body?.error === 'string' && body.error !== '' ? body.error : null }
      }
      const file = await response.blob()
      if (signal.aborted) return { done: 'aborted' }
      save(file, `${name}-pip-freeze.txt`)
      return { done: 'saved' }
    } catch {
      return signal.aborted ? { done: 'aborted' } : { done: 'refused', words: null }
    }
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { EnvironmentInventory } from '@shared/environment-inventory'

  interface Props { name: string; endpoint: string; onclose: () => void; freeze?: EnvironmentFreeze }
  const { name, endpoint, onclose, freeze }: Props = $props()
  let dialog: HTMLDialogElement
  let inventory = $state<EnvironmentInventory | null>(null)
  let loading = $state(true)
  let failed = $state(false)
  let query = $state('')
  const controller = new AbortController()
  const shown = $derived(inventory?.packages.filter(pkg =>
    pkg.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [])

  /*
   * The freeze is the image's, not the list's: the window can read it while
   * the table above is still loading or has failed, and a rebuild changes it
   * under the same address, so it is asked for at the press, never kept here.
   */
  const readable = $derived(freezeReadable(freeze))
  /*
   * The panel's window for an environment with no image here: never built,
   * or the release catalog's, which this server has no docker to open. Its
   * installed packages are no more readable than its freeze, so the window
   * does not ask for them: the request could only fail, and its red "could
   * not read… try again" stood over the foot's true reason with a retry that
   * could never work. The foot's reason is the window's only content, and the
   * window is as tall as that.
   */
  const imageless = $derived(freeze !== undefined && !readable)
  let freezing = $state(false)
  /** The server's refusal in its words, or ours when it never answered; a thunk, so ours follows the language. */
  let freezeErrorText = $state<(() => string) | null>(null)
  const freezeError = $derived(freezeErrorText?.() ?? null)

  function save(file: Blob, filename: string): void {
    const url = URL.createObjectURL(file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    // Inside the dialog: a modal one makes the rest of the page inert.
    dialog.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function downloadFreeze(): Promise<void> {
    if (!readable || freezing) return
    freezing = true
    freezeErrorText = null
    try {
      const press = await pressFreeze(name, freeze, {
        fetch: (input, init) => fetch(input, init),
        save,
        signal: controller.signal,
      })
      if (press.done === 'refused') {
        const { words } = press
        freezeErrorText = () => words ?? tr('admin.env.freezeFailed')
      }
    } finally {
      freezing = false
    }
  }

  async function load(): Promise<void> {
    loading = true
    failed = false
    try {
      const response = await fetch(endpoint, { credentials: 'include', signal: controller.signal })
      if (!response.ok) throw new Error('Inventory unavailable')
      inventory = await response.json()
    } catch {
      if (!controller.signal.aborted) failed = true
    } finally {
      loading = false
    }
  }

  onMount(() => {
    dialog.showModal()
    if (!imageless) void load()
    return () => { controller.abort(); dialog.close() }
  })
</script>

<!--
  The window scrolls as a whole when what it must show is taller than it
  (a small phone, a long reason in the foot): clipped, the foot's button sat
  below the window's edge with nothing to bring it up. While it fits, only the
  table scrolls, as before. With no image to read it is as tall as its words:
  `h-fit`, not `h-auto`, since a modal dialog is fixed between the screen's top
  and bottom, and an auto height stretches it there.
-->
<dialog
  bind:this={dialog}
  class="competition-ui m-auto {imageless ? 'h-fit' : 'h-[min(720px,85dvh)]'} max-h-[85dvh] w-[640px] max-w-[calc(100%-32px)] overflow-y-auto overflow-x-hidden overscroll-contain whitespace-normal border border-line bg-canvas p-0 text-left font-sans font-normal text-ink shadow-pop backdrop:bg-black/50"
  aria-labelledby="environment-details-title"
  onclose={onclose}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      dialog.close()
    }
  }}
>
  <div class="flex h-full flex-col">
    <header class="flex shrink-0 items-start justify-between gap-4 border-b border-line p-5">
      <div class="min-w-0">
        <h2 id="environment-details-title" class="text-title font-bold">{tr('common.environmentDetails')}</h2>
        <p class="mt-1 break-all font-mono text-ui text-muted">{name}</p>
      </div>
      <button type="button" class="flex size-10 shrink-0 items-center justify-center border border-line bg-surface text-head hover:bg-raised" aria-label={tr('common.environmentClose')} onclick={() => dialog.close()}>×</button>
    </header>

    {#if imageless}
      <!-- Nothing to list: there is no image here to read, and the foot says why. -->
    {:else if loading}
      <p class="p-5 text-ui text-muted" role="status">{tr('common.environmentLoading')}</p>
    {:else if failed}
      <div class="p-5">
        <p class="text-ui text-danger" role="alert">{tr('common.environmentUnavailable')}</p>
        <button type="button" class="btn-outline mt-4" onclick={() => void load()}>{tr('common.environmentRetry')}</button>
      </div>
    {:else if inventory}
      <div class="shrink-0 space-y-3 border-b border-line p-5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="font-mono text-title font-bold">Python {inventory.python}</p>
          <p class="text-micro text-muted">{tr('common.environmentPackageCount', { count: inventory.packages.length })}</p>
        </div>
        <p class="text-micro text-muted">{tr('common.environmentInstalled')}</p>
        <input class="field text-ui" type="search" bind:value={query} placeholder={tr('common.environmentSearch')} aria-label={tr('common.environmentSearch')} autocomplete="off" spellcheck="false" />
      </div>
      <!-- A floor under the table: on a phone held sideways the header, the
           search and the foot left it no height at all, and the window now
           scrolls to its foot rather than squeezing the list out. -->
      <div class="min-h-[min(160px,40dvh)] flex-1 overflow-auto overscroll-contain px-5 pb-5">
        <table class="w-full border-collapse text-ui">
          <thead class="sticky top-0 bg-canvas">
            <tr class="border-b border-line text-micro text-muted">
              <th scope="col" class="py-3 pr-4 text-left font-semibold">{tr('common.environmentPackage')}</th>
              <th scope="col" class="py-3 text-right font-semibold">{tr('common.environmentVersion')}</th>
            </tr>
          </thead>
          <tbody>
            {#each shown as pkg (pkg.name)}
              <tr class="border-b border-line-soft">
                <td class="break-all py-2 pr-4 font-mono text-2xs">{pkg.name}</td>
                <td class="break-all py-2 text-right font-mono text-2xs tabular-nums">{pkg.version}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if shown.length === 0}<p class="py-5 text-ui text-muted" role="status">{tr('common.environmentNoMatches')}</p>{/if}
      </div>
    {/if}

    <!--
      The action stands at the foot whatever the table above is doing, the
      way the panel's editor keeps its buttons: `mt-auto` holds it there
      under a one-line "loading" too. When it cannot be pressed, the line
      beside it says why, and on a phone that line takes the width and the
      button goes under it. In a window with no image the foot is all there
      is, right under the header, padded like it.
    -->
    {#if freeze}
      <footer class="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 {imageless ? 'p-5' : 'border-t border-line px-5 py-3'}">
        <div
          id="environment-freeze-note"
          class="min-w-0 flex-1 basis-[240px] text-2xs {freezeError ? 'text-danger' : 'text-muted'}"
          role={freezeError ? 'alert' : undefined}
        >
          {#if freezeError}
            {freezeError}
          {:else if freeze.catalogImage !== null}
            {tr('admin.env.freezeManaged')}
            <code class="mt-1.5 block break-all border border-line bg-surface px-2 py-1.5 font-mono text-micro text-ink">docker run --rm --network none --entrypoint python {freeze.catalogImage} -m pip freeze --all</code>
          {:else if !freeze.built}
            {tr('admin.env.freezeUnbuilt')}
          {:else}
            {tr('admin.env.freezeHint')}
          {/if}
        </div>
        <button
          type="button"
          class="btn-outline ml-auto shrink-0"
          disabled={!readable || freezing}
          aria-describedby="environment-freeze-note"
          onclick={() => void downloadFreeze()}
        >
          {freezing ? tr('admin.env.freezeReading') : tr('admin.env.freeze')}
        </button>
      </footer>
    {/if}
  </div>
</dialog>
