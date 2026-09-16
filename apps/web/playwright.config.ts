import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir:'tests/e2e', timeout:60000, fullyParallel:false, workers:1,
  use:{baseURL:'http://127.0.0.1:5174',trace:'retain-on-failure',screenshot:{mode:'only-on-failure',fullPage:true}},
  projects:[
    {name:'desktop',use:{...devices['Desktop Chrome']}},
    {name:'firefox',use:{...devices['Desktop Firefox']}},
    {name:'webkit',use:{...devices['Desktop Safari']}},
    {name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'webkit'}},
  ],
  reporter:'list',
})
