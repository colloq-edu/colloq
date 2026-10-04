<script lang="ts">
  /**
   * "OPEN DATA" on the task tab — the files a participant downloads and finds
   * in `data/` (C3).
   *
   * An open file that a hidden test replaces during the check is marked as
   * the EXAMPLE it is, right in its row: its rows, and under it the hidden
   * test's rows and the promise that the path stays the same. Without that a
   * notebook fitted to 200 example rows meets 2 000 in the check and fails
   * with nothing to go on — the hidden test's text never comes back (C1).
   *
   * The hidden test itself has no row and no link: there is nothing to
   * download, and the note under the list says so.
   */
  import { formatNumber, tr } from '@shared/i18n'
  import type { EntrantFile, EntrantSealedFile } from '@shared/competitions-entrant'
  import { fileSize, sealedColumnsWords, sealedSwapWords } from '@/lib/competition-words'

  interface Props {
    files: EntrantFile[]
    sealedFiles?: EntrantSealedFile[]
    fileUrl: (name: string) => string
  }

  const { files, sealedFiles = [], fileUrl }: Props = $props()

  /** The hidden test standing in for each example, by the example's name. */
  const swaps = $derived(new Map(sealedFiles.filter((file) => file.replaces !== null).map((file) => [file.replaces!, file])))
</script>

<section class="flex max-w-[760px] flex-col gap-3">
  <h2 class="text-micro font-black uppercase leading-5 tracking-label text-muted">
    {tr('competitions.p.dataTitle')}
  </h2>
  {#if files.length === 0}
    <p class="text-2xs text-muted">{tr('competitions.p.noFiles')}</p>
  {:else}
    <div class="flex flex-col border-t border-ink">
      {#each files as file (file.name)}
        {@const swap = file.sealed ? (swaps.get(file.name) ?? null) : null}
        <div
          class="flex flex-col gap-2 border-b border-line px-2 py-2.5 sm:px-3 {file.sealed ? 'bg-brand-2/5 dark:bg-accent/10' : ''}"
          data-file={file.name}
        >
          <div class="flex items-center gap-3">
            <svg width="16" height="16" viewBox="0 0 16 16" class="shrink-0 text-accent-text" aria-hidden="true">
              <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
            <span class="flex min-w-0 grow flex-wrap items-center gap-x-3 gap-y-1">
              <!-- On a phone a long name wraps instead of ending in "data/sample…":
                   the name is what the notebook reads, and half of it is no name. -->
              <a
                class="min-w-0 break-all font-mono text-micro hover:underline sm:truncate sm:break-normal"
                href={fileUrl(file.name)}
                download
                title={file.name}
              >
                <span class="text-muted">data/</span><span class="text-accent-text">{file.name}</span>
              </a>
              {#if file.sealed}
                <span class="shrink-0 border border-brand-2 px-1.5 text-micro font-black uppercase leading-4 tracking-label text-brand-2 dark:border-accent dark:text-accent">
                  {tr('competitions.p.sealedExample')}
                </span>
              {/if}
            </span>
            <span class="w-[88px] shrink-0 text-micro text-muted sm:w-[120px]">
              {file.rows === null ? '' : tr('competitions.p.rows', { count: file.rows, n: formatNumber(file.rows) })}
            </span>
            <span class="w-16 shrink-0 text-right text-micro text-muted">
              {fileSize(file.bytes)}
            </span>
          </div>
          {#if file.sealed}
            <div class="flex flex-col gap-1 pl-7">
              <span class="flex items-start gap-2">
                <svg width="16" height="16" viewBox="0 0 16 16" class="mt-0.5 shrink-0 text-brand-2 dark:text-accent" aria-hidden="true">
                  <path
                    d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                </svg>
                <span class="text-2xs font-semibold text-brand-2 dark:text-accent">{sealedSwapWords(swap?.rows ?? null)}</span>
              </span>
              {#if swap?.columns}
                <span class="break-words pl-6 text-micro text-muted">{sealedColumnsWords(swap.columns)}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    <p class="text-micro leading-[18px] text-muted">
      {[tr('competitions.p.dataNote'), sealedFiles.length > 0 ? tr('competitions.p.sealedNotListed') : '']
        .filter(Boolean)
        .join(' ')}
    </p>
  {/if}
</section>
