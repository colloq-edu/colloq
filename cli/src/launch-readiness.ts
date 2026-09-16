/** Vite can serve index.html even while the application's stylesheet cannot compile. */
export async function devFrontendReady(url: string): Promise<boolean> {
  for (const resource of ['/', '/src/index.css']) {
    let response: Response
    try {
      response = await fetch(new URL(resource, url), { signal: AbortSignal.timeout(5000) })
      await response.arrayBuffer()
    } catch {
      return false
    }
    if (response.status >= 500)
      throw new Error(`Vite could not compile ${resource}. Check the frontend error above.`)
    if (!response.ok) return false
  }
  return true
}
