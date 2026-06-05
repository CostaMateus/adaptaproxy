import { Hono } from 'hono'
import { config } from '../core/config.ts'

const app = new Hono()

function adaptaModel(id = config.adapta.modelId) {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'adapta',
  }
}

app.get('/v1/models', c => {
  return c.json({
    object: 'list',
    data: [adaptaModel()],
  })
})

app.get('/v1/models/:model', c => {
  const modelId = c.req.param('model')
  if (modelId !== config.adapta.modelId) {
    return c.json({ error: 'Model not found' }, 404)
  }
  return c.json(adaptaModel(modelId))
})

export { app }
