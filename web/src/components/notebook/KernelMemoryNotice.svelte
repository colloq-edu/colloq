<script lang="ts">
  /*
   * The cell's answer when the server would not start its kernel for memory
   * (K5, Paper «12 · Ядра и память»).
   *
   * On 9 Oct 2026 this was a red "KernelError: Not enough available memory
   * for this kernel allocation" under the cell, in a Russian room, on code
   * that was fine. It is not the cell's failure, so it does not wear the
   * failure's colours: a warning bar, a warm tint, and words that say what
   * happened and what to do. The words depend on who reads them: only the
   * owner can free memory, so only the owner gets the link (see
   * shared/kernel-problem.ts · kernelMemoryNotice).
   */
  import { tr } from '@shared/i18n'
  import { KERNEL_MEMORY_ADMIN_HREF, kernelMemoryNotice } from '@shared/kernel-problem'
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /** The viewer is the server's owner (the control socket's `role` frame). */
    owner?: boolean
  }

  let { owner = false }: Props = $props()

  // `tr` reads the room's language reactively: the words follow a switch.
  const notice = $derived(kernelMemoryNotice(owner))
</script>

<div
  class="flex flex-col gap-1 border-l-[3px] border-l-warning bg-warning/[0.08] pb-3 pl-3 pr-3.5 pt-2.5"
  role="status"
>
  <p class="text-code font-bold text-warning">{notice.title}</p>
  <p class="text-code text-ink">{notice.body}</p>
  {#if notice.link}
    <div class="flex pt-1">
      <!-- A new tab: the class goes on in this one, and the Resources tab is
           where the owner stops the idle classes and comes back. -->
      <a
        href={KERNEL_MEMORY_ADMIN_HREF}
        target="_blank"
        rel="noopener"
        class="inline-flex h-5 items-center gap-1.5 border-b border-accent-text text-code font-bold
               text-accent-text hover:text-ink focus-visible:outline-none focus-visible:ring-2
               focus-visible:ring-accent/40"
      >
        {notice.link}
        <Icon name="arrow-right" size={12} />
      </a>
    </div>
  {/if}
</div>
