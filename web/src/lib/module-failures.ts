/** Errors already displayed by a local capability boundary with a retry action. */
const handled = new WeakSet<object>()

export function handleModuleFailure(error: unknown): void {
  if (error !== null && typeof error === 'object') handled.add(error)
}

export function moduleFailureHandled(error: unknown): boolean {
  return error !== null && typeof error === 'object' && handled.has(error)
}
