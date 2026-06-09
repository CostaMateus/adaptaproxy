import { config } from '../core/config.ts'

export interface AdaptaModelInfo {
  id: string
  label: string
  familyKey: string | null
  enabled: boolean
  order: number
  badge?: string | null
  shortDescription?: string | null
}

const MODELS_URL = 'https://one-admin-prod.vercel.app/api/models/v1'
const CACHE_TTL_MS = 10 * 60 * 1000

let cachedModels: { expiresAt: number, models: AdaptaModelInfo[] } | null = null

function modelFromPayload(model: any): AdaptaModelInfo | null {
  if (!model || typeof model.key !== 'string') return null
  return {
    id: model.key,
    label: typeof model.label === 'string' ? model.label : model.key,
    familyKey: typeof model.familyKey === 'string' ? model.familyKey : null,
    enabled: model.enabled !== false,
    order: Number.isFinite(model.order) ? model.order : 999,
    badge: typeof model.badge === 'string' ? model.badge : null,
    shortDescription: typeof model.shortDescription === 'string' ? model.shortDescription : null,
  }
}

function fallbackModels(): AdaptaModelInfo[] {
  return [{
    id: config.adapta.modelId,
    label: config.adapta.modelId,
    familyKey: null,
    enabled: true,
    order: 0,
    badge: null,
    shortDescription: 'Modelo padrão',
  }]
}

function dedupeModels(models: AdaptaModelInfo[]): AdaptaModelInfo[] {
  const byId = new Map<string, AdaptaModelInfo>()
  for (const model of models) {
    if (!model.enabled) continue
    const existing = byId.get(model.id)
    if (!existing || model.id === config.adapta.modelId) {
      byId.set(model.id, model)
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.id === config.adapta.modelId) return -1
    if (b.id === config.adapta.modelId) return 1
    return a.order - b.order || a.label.localeCompare(b.label)
  })
}

export async function listAdaptaModels(): Promise<AdaptaModelInfo[]> {
  if (cachedModels && cachedModels.expiresAt > Date.now()) return cachedModels.models

  try {
    const response = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(config.timeouts.http),
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

    const payload = await response.json() as any
    const views = payload?.data?.text?.views || {}
    const models = [
      ...(Array.isArray(views.general?.models) ? views.general.models : []),
      ...(Array.isArray(views.workspace?.models) ? views.workspace.models : []),
    ]
      .map(modelFromPayload)
      .filter((model: AdaptaModelInfo | null): model is AdaptaModelInfo => Boolean(model))

    const listed = dedupeModels(models.length ? models : fallbackModels())
    cachedModels = { expiresAt: Date.now() + CACHE_TTL_MS, models: listed }
    return listed
  } catch (error: any) {
    console.warn(`[Adapta models] Could not fetch model list: ${error.message}`)
    return fallbackModels()
  }
}

export async function getAdaptaModel(id: string): Promise<AdaptaModelInfo | null> {
  const models = await listAdaptaModels()
  return models.find(model => model.id === id) || null
}
