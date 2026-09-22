/** Installed Python distributions, including inherited and transitive dependencies. */
export interface EnvironmentInventory {
  name: string
  python: string
  packages: { name: string; version: string }[]
}
