import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Massive's API supports CORS natively so no proxy needed,
  // unlike Yahoo Finance which required browser request routing.
})
