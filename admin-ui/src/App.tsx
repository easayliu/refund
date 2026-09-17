import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAuthState } from '@/api/auth'
import { getPw } from '@/api/client'
import { UserPage } from '@/components/user-page'
import { AdminPage } from '@/components/admin-page'
import { LoginPage } from '@/components/login-page'

/** 极简 hash 路由：`#/admin` 进管理页（需登录），其余进用户提交页。 */
function useRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function App() {
  const route = useRoute()
  const [pw, setPwState] = useState<string | null>(getPw())

  const isAdmin = route.startsWith('#/admin')

  // 只有进管理区时才需要鉴权状态；用户页完全公开。
  const auth = useQuery({ queryKey: ['auth-state'], queryFn: getAuthState, enabled: isAdmin })

  if (!isAdmin) {
    return <UserPage />
  }

  // 管理区：鉴权状态未知先留白；已配置且未登录 → 登录页；未配置 → 登录页的「首次设置」态。
  if (auth.isLoading || !auth.data) {
    return <div className="app-shell min-h-dvh" />
  }

  const needLogin = auth.data.configured && !pw
  const needSetup = !auth.data.configured
  if (needLogin || needSetup) {
    return <LoginPage authState={auth.data} onSuccess={(p) => setPwState(p)} />
  }

  return <AdminPage onSignOut={() => setPwState(null)} />
}

export default App
