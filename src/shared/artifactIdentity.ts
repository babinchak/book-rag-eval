import { createHash } from 'node:crypto'

export const ARTIFACT_IDENTITY_VERSION = 1

type JsonPrimitive = string | number | boolean | null
type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson }

export interface ArtifactIdentity<TConfig = unknown> {
  version: typeof ARTIFACT_IDENTITY_VERSION
  kind: string
  id: string
  config: TConfig
  dependencies: Record<string, string>
}

function canonicalize(value: unknown, location: string): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${location}`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      item === undefined ? null : canonicalize(item, `${location}[${index}]`)
    )
  }
  if (value && typeof value === 'object') {
    const result: Record<string, CanonicalJson> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) continue
      result[key] = canonicalize(item, `${location}.${key}`)
    }
    return result
  }
  throw new Error(`Unsupported fingerprint value at ${location}: ${typeof value}`)
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'))
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function createArtifactIdentity<TConfig>(
  kind: string,
  config: TConfig,
  dependencies: Record<string, string> = {}
): ArtifactIdentity<TConfig> {
  const descriptor: Omit<ArtifactIdentity<TConfig>, 'id'> = {
    version: ARTIFACT_IDENTITY_VERSION,
    kind,
    config,
    dependencies
  }
  return {
    ...descriptor,
    id: contentHash(descriptor)
  }
}
