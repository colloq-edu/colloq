<script lang="ts" module>
  /**
   * The image's `pip freeze` as a file, offered at the window's foot: by the
   * panel's window, which knows from its list of environments whether an
   * image is there, and by a competition page's (ListedFreeze), which learns
   * it with the package list.
   */
  export interface EnvironmentFreeze {
    /** The route answering `<name>-pip-freeze.txt`, or words when it cannot. */
    endpoint: string
    /** An image is there to read: false for an environment never built. */
    built: boolean
    /** The release catalog's pinned image, which this server has no docker to run; null otherwise. */
    catalogImage: string | null
    /** The note beside the button in the opening page's words; absent, the panel's (admin.env.freeze*). */
    words?: FreezeWords
  }

  /**
   * The note beside the button, as thunks so it follows the language. The
   * panel speaks of its rooms and its builds; a competition page of the image
   * its submissions are checked in, and its catalog carries no panel words.
   *
   * A reason is told whether it stands `alone`: with no package list above
   * it, it is all the window says and speaks for the missing list too; under
   * the list a competition's pinned revision keeps, of the pip freeze alone.
   */
  export interface FreezeWords {
    /** An image to read: what the file is. */
    hint: () => string
    /** No image here to read. */
    unbuilt: (alone: boolean) => string
    /** The release catalog's image with no docker here: the words before the command that prints its freeze. */
    managed: (alone: boolean) => string
  }

  /**
   * A competition page's freeze. The page knows nothing of the server's
   * images, so its window asks for them with the list (whose endpoint carries
   * `?freeze`, routes/competitions.ts) and takes them from the answer, a
   * refusal's as well as the list's (listedFreeze).
   */
  export interface ListedFreeze {
    endpoint: string
    listed: true
    words: FreezeWords
  }

  /**
   * A ListedFreeze with what its list's answer says of the image. An answer
   * that says nothing (its door could not tell, docker not answering) is an
   * image to read: nothing is known against it, and a press says what the
   * server finds.
   */
  export function listedFreeze(freeze: ListedFreeze, answer: unknown): EnvironmentFreeze {
    const told = (answer as { freeze?: { built?: unknown; catalogImage?: unknown } } | null)?.freeze
    return {
      endpoint: freeze.endpoint,
      built: typeof told?.built === 'boolean' ? told.built : true,
      catalogImage: typeof told?.catalogImage === 'string' && told.catalogImage !== '' ? told.catalogImage : null,
      words: freeze.words,
    }
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
  import Skeleton from './Skeleton.svelte'

  interface Props { name: string; endpoint: string; onclose: () => void; freeze?: EnvironmentFreeze | ListedFreeze }
  const { name, endpoint, onclose, freeze }: Props = $props()
  let dialog: HTMLDialogElement
  let inventory = $state<EnvironmentInventory | null>(null)
  let loading = $state(true)
  let failed = $state(false)
  let query = $state('')
  const controller = new AbortController()
  const shown = $derived(inventory?.packages.filter(pkg =>
    pkg.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [])

  /** A competition page's freeze once its list's answer has told what the image is; undefined until then. */
  let told = $state<EnvironmentFreeze | undefined>(undefined)
  /** The freeze the foot offers: the panel's as given, a competition page's as its list told it. */
  const offered = $derived(freeze !== undefined && 'listed' in freeze ? told : freeze)

  /*
   * The freeze is the image's, not the list's: the window can read it while
   * the table above is still loading or has failed, and a rebuild changes it
   * under the same address, so it is asked for at the press, never kept here.
   */
  const readable = $derived(freezeReadable(offered))
  /*
   * A window with no image here to read and no list either: never built, or
   * the release catalog's, which this server has no docker to open. Its
   * installed packages are no more readable than its freeze, and their red
   * "could not read… try again" stood over the foot's true reason with a
   * retry that could never work. The foot's reason is the window's only
   * content, and the window is as tall as that. The panel's window knows it
   * before it opens, and does not ask for the list: the request could only
   * fail. A competition page's list may be its pinned revision's, which the
   * server keeps whatever the machine has, so its window asks, and stands
   * without a list only when none came.
   */
  const imageless = $derived(offered !== undefined && !readable && inventory === null)
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
      const press = await pressFreeze(name, offered, {
        fetch: (input, init) => fetch(input, init),
        save,
        signal: controller.signal,
      })
      if (press.done === 'refused') {
        const { words } = press
        freezeErrorText = () => words ?? tr('common.environmentFreezeFailed')
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
      const body: unknown = await response.json().catch(() => null)
      // A competition page's window learns its image from this answer, a refusal's as well as the list's.
      if (freeze !== undefined && 'listed' in freeze) told = listedFreeze(freeze, body)
      if (!response.ok || body === null) throw new Error('Inventory unavailable')
      inventory = body as EnvironmentInventory
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
      <!--
        The image's inventory is on its way (docker image inspect and the
        package list: the slowest read the panel makes). The head and the
        table where they will stand: the window's own words in words, the
        Python line, the count and the rows grey, the search faded.
      -->
      <div class="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label={tr('common.environmentLoading')}>
        <span class="sr-only">{tr('common.environmentLoading')}</span>
        <div class="shrink-0 space-y-3 border-b border-line p-5" aria-hidden="true">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="font-mono text-title font-bold"><Skeleton width="8rem" height="1rem" /></p>
            <p class="text-micro"><Skeleton width="6rem" height="0.6rem" /></p>
          </div>
          <p class="text-micro text-muted">{tr('common.environmentInstalled')}</p>
          <input class="field text-ui" type="search" disabled tabindex="-1" placeholder={tr('common.environmentSearch')} />
        </div>
        <div class="min-h-[min(160px,40dvh)] flex-1 overflow-hidden px-5 pb-5" aria-hidden="true">
          <table class="w-full border-collapse text-ui">
            <thead>
              <tr class="border-b border-line text-micro text-muted">
                <th scope="col" class="py-3 pr-4 text-left font-semibold">{tr('common.environmentPackage')}</th>
                <th scope="col" class="py-3 text-right font-semibold">{tr('common.environmentVersion')}</th>
              </tr>
            </thead>
            <tbody>
              {#each ['9rem', '6rem', '11rem', '7.5rem', '10rem', '5.5rem', '8rem', '12rem'] as width, i (i)}
                <tr class="border-b border-line-soft">
                  <td class="py-2 pr-4 text-2xs"><Skeleton {width} height="0.65rem" /></td>
                  <td class="py-2 text-right text-2xs"><Skeleton width="3.5rem" height="0.65rem" /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
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
      is, right under the header, padded like it. A competition page's foot
      comes with its list, once the answer has said what the image is.
    -->
    {#if offered}
      <footer class="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 {imageless ? 'p-5' : 'border-t border-line px-5 py-3'}">
        <div
          id="environment-freeze-note"
          class="min-w-0 flex-1 basis-[240px] text-2xs {freezeError ? 'text-danger' : 'text-muted'}"
          role={freezeError ? 'alert' : undefined}
        >
          {#if freezeError}
            {freezeError}
          {:else if offered.catalogImage !== null}
            {offered.words?.managed(imageless) ?? tr('admin.env.freezeManaged')}
            <code class="mt-1.5 block break-all border border-line bg-surface px-2 py-1.5 font-mono text-micro text-ink">docker run --rm --network none --entrypoint python {offered.catalogImage} -m pip freeze --all</code>
          {:else if !offered.built}
            {offered.words?.unbuilt(imageless) ?? tr('admin.env.freezeUnbuilt')}
          {:else}
            {offered.words?.hint() ?? tr('admin.env.freezeHint')}
          {/if}
        </div>
        <button
          type="button"
          class="btn-outline ml-auto shrink-0"
          disabled={!readable || freezing}
          aria-describedby="environment-freeze-note"
          onclick={() => void downloadFreeze()}
        >
          {freezing ? tr('common.environmentFreezeReading') : tr('common.environmentFreeze')}
        </button>
      </footer>
    {/if}
  </div>
</dialog>
