import fs from 'node:fs'
import path from 'node:path'
import { dependencySource, DependencySourceError, type DependencySource } from '@shared/dependency-source'
import { proxyEnvironmentFor } from '../outbound.js'
import { DependencyPreparationError } from './preparation-contract.js'

/**
 * What a preparation takes from the operator's settings, read once per
 * preparation (a changed .env reaches the next one):
 *
 *   - the index and the hosts its files come from (DEPENDENCY_INDEX_URL,
 *     DEPENDENCY_FILES_HOSTS; shared/dependency-source.ts);
 *   - the institution's CA (NODE_EXTRA_CA_CERTS), which reaches pip as a file
 *     of the request (`input/extra-ca.pem`) rather than as a mount: the
 *     server may itself run in a container, where its path means nothing to
 *     the Docker daemon, and on k3s the resolver Pod mounts the same input
 *     folder, so one road serves both backends;
 *   - the institution's proxy (HTTPS_PROXY, NO_PROXY) for the one container
 *     that leaves the campus, the CONNECT proxy (Docker backend only).
 *
 * A setting that cannot be used is the operator's to fix, and it is said as
 * such: the preparation fails with code `preparation_config`, which the page
 * shows as the general "could not prepare" text and the technical log as the
 * exact reason. The CA is the exception: Node itself only warns about a bad
 * NODE_EXTRA_CA_CERTS, and public PyPI does not need it, so a preparation
 * goes on without it and says so in the journal.
 */
export interface PreparationSource {
  source: DependencySource
  /** PEM text of the institution's CA bundle, or null. */
  extraCa: string | null
  /** HTTPS_PROXY/NO_PROXY for the CONNECT proxy container; empty without a proxy. */
  proxyEnv: Record<string, string>
}

const MAX_CA_BYTES = 1024 * 1024
let caWarned = ''

function extraCaBundle(env: NodeJS.ProcessEnv): string | null {
  const file = (env.NODE_EXTRA_CA_CERTS ?? '').trim()
  if (!file) return null
  let problem: string
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_CA_BYTES) problem = 'is not a PEM file under 1 MiB'
    else {
      const text = fs.readFileSync(file, 'utf8')
      if (text.includes('-----BEGIN CERTIFICATE-----')) return text
      problem = 'holds no PEM certificate'
    }
  } catch (error) {
    problem = `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`
  }
  if (caWarned !== file) {
    caWarned = file
    console.warn(`[dependencies] NODE_EXTRA_CA_CERTS=${file} ${problem}; package preparation trusts the public roots only`)
  }
  return null
}

/**
 * `chain`: whether this backend's CONNECT proxy goes out through the
 * institution's proxy (Docker). The k3s proxy Pod does not: its way out is
 * the network policy the installer renders (to public PyPI or the mirror).
 */
export function preparationSource(env: NodeJS.ProcessEnv = process.env, { chain }: { chain: boolean } = { chain: true }): PreparationSource {
  let source: DependencySource
  try {
    source = dependencySource(env)
  } catch (error) {
    if (error instanceof DependencySourceError) throw new DependencyPreparationError('preparation_config', error.message)
    throw error
  }
  const proxyEnv = chain ? proxyEnvironmentFor(env) : {}
  // The CONNECT proxy speaks plain TCP to the institution's proxy; a TLS
  // connection to the proxy itself is not something it can open.
  if (proxyEnv.HTTPS_PROXY && !proxyEnv.HTTPS_PROXY.startsWith('http://')) {
    throw new DependencyPreparationError(
      'preparation_config',
      'HTTPS_PROXY must be an http:// proxy for package preparation to chain through it',
    )
  }
  return { source, extraCa: extraCaBundle(env), proxyEnv }
}

/** The request the preparation program reads: the job plus where its packages come from. */
export function preparationJob<T extends object>(job: T, prepared: PreparationSource): T & { index: { url: string; publicPypi: boolean; files: string[] } } {
  const { indexUrl, publicPypi, files } = prepared.source
  return { ...job, index: { url: indexUrl, publicPypi, files } }
}

/** Put the CA next to request.json, readable by the preparation user (uid 1000), when there is one. */
export function writeExtraCa(inputDir: string, prepared: PreparationSource, mode: number): void {
  if (prepared.extraCa) fs.writeFileSync(path.join(inputDir, 'extra-ca.pem'), prepared.extraCa, { mode })
}
