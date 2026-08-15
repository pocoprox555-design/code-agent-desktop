import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { external: ['fsevents'], input: { index: resolve('src/main/index.ts'), 'deploy-worker': resolve('src/main/deploy-worker.ts') } } },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
