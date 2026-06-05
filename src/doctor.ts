import 'dotenv/config'
import { config } from './core/config.ts'
import { initPlaywright, closePlaywright } from './services/playwright.ts'
import { buildDoctorReport } from './core/doctor.ts'

const browserType = (process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1] || process.env.BROWSER || 'chromium') as any

try {
  await initPlaywright(config.browser.headless, browserType)
  const report = await buildDoctorReport()
  console.log(JSON.stringify(report, null, 2))
  await closePlaywright()
  process.exit(report.status === 'unhealthy' ? 1 : 0)
} catch (error: any) {
  await closePlaywright().catch(() => {})
  console.error(JSON.stringify({
    status: 'unhealthy',
    error: error?.message || String(error),
  }, null, 2))
  process.exit(1)
}
