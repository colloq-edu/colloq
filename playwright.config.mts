import {defineConfig} from '@playwright/test'

// Never attach to the author's live instance. The launcher owns a temporary DB,
// fixed loopback-only test port, and refuses reuse of an existing server.
export default defineConfig({
 testDir:'./tests/browser',testMatch:'**/*.spec.ts',workers:1,fullyParallel:false,
 timeout:45000,expect:{timeout:15000},retries:process.env.CI?1:0,
 outputDir:'./test-results/browser',reporter:process.env.CI?'github':'list',
 use:{baseURL:'http://127.0.0.1:4317',browserName:'chromium',trace:'retain-on-failure'},
 webServer:{command:'node --import tsx tests/browser/server.mts',url:'http://127.0.0.1:4317/api/livez',reuseExistingServer:false,timeout:45000,gracefulShutdown:{signal:'SIGTERM',timeout:5000}},
})
