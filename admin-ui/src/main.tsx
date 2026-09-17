import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { LanguageProvider } from '@/lib/i18n'
import { initTheme } from '@/lib/theme'
import './index.css'

// 渲染前先上色：系统 / 浅色 / 深色三态。
initTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, refetchOnWindowFocus: false, retry: 1 },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </LanguageProvider>
  </React.StrictMode>,
)
