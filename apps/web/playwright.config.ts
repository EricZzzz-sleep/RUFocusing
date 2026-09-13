import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir:'tests/e2e', timeout:60000, fullyParallel:false, workers:1,
  use:{baseURL:'http://127.0.0.1:5174',trace:'retain-on-failure'},
  projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
  reporter:'list',
})
