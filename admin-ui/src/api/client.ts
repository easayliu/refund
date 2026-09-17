import axios from 'axios'

const PW_KEY = 'refund_admin_pw'

export const getPw = () => {
  try {
    return localStorage.getItem(PW_KEY)
  } catch {
    return null
  }
}
export const setPw = (pw: string) => {
  try {
    localStorage.setItem(PW_KEY, pw)
  } catch {
    // ignore
  }
}
export const clearPw = () => {
  try {
    localStorage.removeItem(PW_KEY)
  } catch {
    // ignore
  }
}

/** 全局 axios 实例：管理接口自动带管理密码，401 时清除并回登录。 */
export const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((cfg) => {
  const pw = getPw()
  if (pw) cfg.headers.Authorization = `Bearer ${pw}`
  return cfg
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status
    const url: string = err?.config?.url ?? ''
    // 已存密码却 401 → 密码失效：清除并刷新回登录（排除鉴权自身接口，避免登录报错时误刷）。
    if (status === 401 && getPw() && !url.startsWith('/auth/')) {
      clearPw()
      window.location.reload()
    }
    return Promise.reject(err)
  },
)
