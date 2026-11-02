/**
 * What the fixture server (server.mts) lays out and the specs rely on.
 *
 * The setup token is not a secret here: the instance is a throwaway on
 * loopback with a temporary database, and signing in with it is the same
 * documented way back in an operator uses (POST /api/admin/signin/token).
 */
export const SETUP_TOKEN = 'browser-fixture-setup-token'

/** A room with a deck and the server's notes on every slide. */
export const NOTES_ROOM = 'browser-notes'
export const NOTES_FILE = 'slides.pdf'
export const SERVER_NOTES = ['Server page one', 'Server page two', 'Server page three']

/** A small PDF, ASCII throughout, so it travels as text: one line of type per page. */
export function slides(count: number): string {
  const objects: string[] = []
  const font = 3 + count * 2
  const kids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const page = 3 + index * 2
    const stream = `BT /F1 48 Tf 72 160 Td (Slide ${index + 1}) Tj ET`
    kids.push(`${page} 0 R`)
    objects[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Contents ${page + 1} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> >>`
    objects[page + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`
  objects[font] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  return out + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}
