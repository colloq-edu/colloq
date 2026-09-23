/** Installed Python distributions, including inherited and transitive dependencies. */
export interface EnvironmentInventory {
  /** Present when this inventory is bound to the competition execution base. */
  revisionId?: string
  name: string
  python: string
  packages: { name: string; version: string }[]
}
