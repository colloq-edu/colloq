/**
 * ANSI colour handling, kept out of the runes module on purpose: these are pure
 * functions over strings, and a module that declares $state cannot be imported
 * by anything but the Svelte compiler — which would put them beyond the reach
 * of a test.
 */

/*
 * IPython paints its tracebacks with xterm-256 codes, not the basic sixteen.
 * ansi_up's use_classes mode only turns the basic sixteen into classes; a 256
 * colour stays an inline `color:` that no stylesheet can reach, and those are
 * the ones that measured 4.01:1 on our dark ground — inside a traceback, which
 * is the worst place to lose a word.
 *
 * So the codes are folded down to the nearest of the sixteen before conversion,
 * and every colour the kernel asks for arrives through the measured palette.
 * Hue is preserved; only the shade is given up, and the shade was the part that
 * was unreadable.
 */
const CUBE = [0, 95, 135, 175, 215, 255]

/** The basic-16 index whose hue is closest to an xterm-256 index. */
export function ansi256ToBasic(code: number): number {
  if (code < 16) return code
  let r: number, g: number, b: number
  if (code < 232) {
    const n = code - 16
    r = CUBE[Math.floor(n / 36) % 6]
    g = CUBE[Math.floor(n / 6) % 6]
    b = CUBE[n % 6]
  } else {
    // The greyscale ramp: everything from near-black to near-white.
    r = g = b = 8 + (code - 232) * 10
  }
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  // Near-grey: the ramp and the desaturated cube become black or white, and the
  // "bright" half of each is what keeps a dim grey from vanishing.
  if (max - min < 40) return max < 96 ? 0 : max < 176 ? 8 : max < 232 ? 7 : 15
  const bright = max >= 176 ? 8 : 0
  const on = (v: number) => (v >= min + (max - min) * 0.6 ? 1 : 0)
  // Bit per channel, in the ANSI order: red 1, green 2, blue 4.
  return bright + on(r) * 1 + on(g) * 2 + on(b) * 4
}

/**
 * Rewrites 256-colour and truecolor SGR parameters to their basic-16 equivalent,
 * leaving every other escape untouched.
 */
export function foldAnsiColours(text: string): string {
  // eslint-disable-next-line no-control-regex -- escape sequences are the subject
  return text.replace(/\x1b\[([0-9;]*)m/g, (whole, params: string) => {
    const parts = params.split(';').filter((p) => p !== '')
    const out: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i])
      if ((n === 38 || n === 48) && parts[i + 1] === '5') {
        const basic = ansi256ToBasic(Number(parts[i + 2] ?? 7))
        out.push(String((n === 38 ? 30 : 40) + (basic % 8) + (basic >= 8 ? 60 : 0)))
        i += 2
        continue
      }
      if ((n === 38 || n === 48) && parts[i + 1] === '2') {
        // 38;2;R;G;B — the channels start at i+2, right after the '2'.
        const [r, g, b] = [2, 3, 4].map((k) => Number(parts[i + k] ?? 0))
        const basic = ansi256ToBasic(16 + 36 * nearestCube(r) + 6 * nearestCube(g) + nearestCube(b))
        out.push(String((n === 38 ? 30 : 40) + (basic % 8) + (basic >= 8 ? 60 : 0)))
        i += 4
        continue
      }
      out.push(parts[i])
    }
    return `\x1b[${out.join(';')}m` === whole ? whole : `\x1b[${out.join(';')}m`
  })
}

/*
 * Одна escape-последовательность целиком, от начала строки. Те же три вида, что
 * и в ANSI_PATTERN ниже, но с якорем: здесь спрашивают не «где они», а
 * «дописана ли последняя». Отсюда и разница в третьей ветке: `]` из неё убран,
 * иначе начатый OSC (`\x1b]8;;http://…`) считался бы законченным двухсимвольным
 * escape'ом и его разрезали бы пополам.
 */
// eslint-disable-next-line no-control-regex -- escape codes are the subject
const ANSI_COMPLETE = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/

/**
 * Длина огрызка escape-последовательности в конце текста; 0 — если его нет.
 *
 * Поток ядра приезжает кусками, и кусок кончается где угодно — в том числе
 * посреди `\x1b[38;5;1`. Тому, кто конвертирует буфер целиком, это безразлично:
 * следующий флеш принесёт его вместе с хвостом. А тому, кто дорисовывает
 * ТОЛЬКО хвост (см. `ansi` в render.svelte.ts), резать здесь нельзя — половина
 * кода уйдёт в разбор как мусор, а вторая половина покрасит остаток лога
 * наугад. Такой огрызок оставляют ждать следующего флеша: на экране он всё
 * равно невидим.
 */
export function pendingEscape(text: string): number {
  const at = text.lastIndexOf('\x1b')
  if (at < 0) return 0
  const rest = text.length - at
  return ANSI_COMPLETE.test(text.slice(at)) ? 0 : rest
}

function nearestCube(v: number): number {
  let best = 0
  for (let i = 1; i < CUBE.length; i++)
    if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i
  return best
}

/*
 * Fallback for the window before the chunk lands. Colour is the only thing
 * lost — dropping the escape codes leaves exactly the text the kernel printed,
 * and it goes out as text, never as markup, so it needs no sanitizer.
 *
 * Covers CSI (\x1b[…), the two-character sequences, and OSC strings, which
 * carry a title or a hyperlink and would otherwise show as visible garbage.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- escape codes are the subject
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}
