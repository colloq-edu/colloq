/** Focus/default-action regression; run: npx tsx scripts/ui-check.mts --cell-selection-only. */
import assert from 'node:assert/strict'

interface Page {
  js(source: string): Promise<unknown>
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export async function checkCellSelection(page: Page): Promise<void> {
  const cells = `document.querySelectorAll('main:not(.hidden) [data-cell-id]')`
  const selected = async () => page.js(`return [...${cells}].map((c,i)=>/selected|выделена/.test(c.getAttribute('aria-label'))?i:null).filter(i=>i!==null)`)
  const focused = async () => page.js(`return !!document.activeElement?.closest('.cm-editor')`)
  async function click(n: number, modifiers = 0, offset = 30) {
    const position = await page.js(`
      const el=${cells}[${n}].querySelector('.cm-content');
      el.scrollIntoView({block:'center'});
      const rect=el.getBoundingClientRect();
      return {x:rect.x+${offset},y:rect.y+10};
    `) as { x: number; y: number }
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1, modifiers })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1, modifiers })
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  for (let i = 0; i < 50; i++) {
    if (await page.js(`return [...${cells}].filter(c=>c.querySelector('.cm-editor:not(.cm-shim)')).length===3`)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(await page.js(`return ${cells}.length`), 3)
  const before = await page.js(`return [...${cells}].map(c=>c.querySelector('.cm-content').textContent)`)
  await click(0, 0, 10)
  await click(0, 8, 85)
  assert.equal(await focused(), true, 'Shift+click inside the active editor keeps text editing focus')
  assert.deepEqual(await selected(), [0], 'text selection stays inside one cell')
  assert.ok(await page.js('return window.getSelection().toString().length > 0'), 'Shift+click extends the text selection')
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 })
  assert.equal(await focused(), true, 'Shift+Arrow stays in text editing mode')
  console.log('PASS Shift inside the active cell selects text by mouse and keyboard')
  for (const [name, modifier] of [['Cmd', 4], ['Ctrl', 2]] as const) {
    await click(0)
    assert.deepEqual(await selected(), [0])
    assert.equal(await focused(), true, 'plain click enters the code editor')
    await click(2, modifier)
    assert.deepEqual(await selected(), [0, 2], `${name}+click in code keeps both whole cells selected`)
    assert.equal(await focused(), false, 'cell selection leaves text editing mode')
    await click(2, modifier)
    assert.deepEqual(await selected(), [0], `${name}+click toggles a cell off`)
    await click(0, modifier)
    assert.deepEqual(await selected(), [], `${name}+click can deselect the final cell`)
    console.log(`PASS ${name}: add, remove, deselect, focus`)
  }
  await click(0)
  await click(2, 8)
  assert.deepEqual(await selected(), [0, 1, 2], 'Shift+click selects the full range through code')
  await click(1, 8)
  assert.deepEqual(await selected(), [0, 1], 'Shift range keeps the original anchor')
  await click(2)
  await click(0, 8)
  assert.deepEqual(await selected(), [0, 1, 2], 'Shift range works backwards')
  await click(1)
  assert.deepEqual(await selected(), [1], 'ordinary code click returns to one cell')
  assert.equal(await focused(), true)
  assert.deepEqual(await page.js(`return [...${cells}].map(c=>c.querySelector('.cm-content').textContent)`), before, 'selection gestures do not edit code')
  console.log('PASS Shift: range, anchor, backwards; ordinary click restores editing; code unchanged')
}
