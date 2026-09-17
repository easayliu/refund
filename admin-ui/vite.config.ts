import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'node:fs'

// 版本号取自 Cargo.toml（唯一真源），读不到退回 dev——它只是页脚一个字符串，
// 绝不能因为读不到就让整个前端构建挂掉。
function readAppVersion(): string {
  try {
    const manifest = readFileSync(path.resolve(__dirname, '../Cargo.toml'), 'utf8')
    return manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'dev'
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // 开发时 /api 代理到本地 refund 后端（默认 4800）。
    proxy: {
      '/api': { target: 'http://127.0.0.1:4800', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
