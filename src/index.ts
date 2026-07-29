import 'dotenv/config'
import { startServer } from './api/server.js'
import { logger } from './core/logger.js'

startServer().catch(error => {
  logger.child('server').error('startup.failed', { error })
  process.exit(1)
})
