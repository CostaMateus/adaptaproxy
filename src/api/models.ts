import { Hono } from 'hono'
import { config } from '../core/config.ts'
import { getAdaptaModel, listAdaptaModels, AdaptaModelInfo } from '../services/adapta-models.ts'

const app = new Hono()

function adaptaModel(model: AdaptaModelInfo) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: 'adapta',
    label: model.label,
    family: model.familyKey,
    default: model.id === config.adapta.modelId,
    badge: model.badge,
    description: model.shortDescription,
  }
}

app.get('/v1/models', async c => {
  const models = await listAdaptaModels()
  return c.json({
    object: 'list',
    data: models.map(adaptaModel),
  })
})

app.get('/v1/models/:model', async c => {
  const modelId = c.req.param('model')
  const model = await getAdaptaModel(modelId)
  if (!model) {
    return c.json({ error: 'Model not found' }, 404)
  }
  return c.json(adaptaModel(model))
})

export { app }
