import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, EyeIcon, EyeOffIcon, LockKeyholeIcon } from 'lucide-react'
import { getAuthState, login, setup, type AuthState } from '@/api/auth'
import { setPw } from '@/api/client'
import { extractError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { LanguageSwitcher } from '@/components/language-switcher'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { LogoMark } from '@/components/logo-mark'
import { useI18n } from '@/lib/i18n'

/**
 * 管理登录页。样式对齐 coban 的 login-page：居中卡片 + 顶部品牌标识 + 右上语言/主题。
 * `authState.configured=false` 时展示「首次设置密码」，否则展示「登录」。
 *
 * 鉴权状态缓存在 react-query 的 `auth-state` 里。设置成功后要立刻把它改成已配置，
 * 否则退出登录再回来时仍会渲染「设置密码」表单，再点就被后端拒绝「管理密码已设置」。
 * 反过来，若页面状态过期、后端说已设置，就直接改走登录，让用户不至于卡死在这一步。
 */
export function LoginPage({ authState, onSuccess }: { authState: AuthState; onSuccess: (pw: string) => void }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const firstTime = !authState.configured

  useEffect(() => {
    document.title = t('管理登录 · refund', 'Admin sign-in · refund')
  }, [t])

  const markConfigured = () =>
    qc.setQueryData<AuthState>(['auth-state'], (old) => ({ ...(old ?? authState), configured: true }))

  const mutate = useMutation({
    mutationFn: async () => {
      if (firstTime) {
        try {
          await setup(password)
        } catch (e) {
          // 400 可能是「密码太短」也可能是「已设置」：回源确认。若确已设置，
          // 说明前端缓存过期，切到登录态并顺手用当前输入试一次登录。
          const fresh = await getAuthState().catch(() => null)
          if (!fresh?.configured) throw e
          qc.setQueryData(['auth-state'], fresh)
        }
      }
      await login(password)
    },
    onSuccess: () => {
      markConfigured()
      setPw(password)
      onSuccess(password)
    },
  })

  return (
    <div className="app-shell relative grid min-h-dvh place-items-center px-4 py-8 text-foreground sm:py-10">
      <div className="absolute end-4 top-4 flex items-center gap-2 sm:end-6 sm:top-6">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="brand-mark flex size-12 items-center justify-center rounded-md">
            <LogoMark className="size-7" />
          </div>
          <div className="mt-4 text-base font-semibold leading-none tracking-tight">refund</div>
          <div className="mt-1.5 text-xs text-muted-foreground">
            {t('管理控制台', 'Admin console')}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base leading-tight">
              <LockKeyholeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              {firstTime ? t('设置管理密码', 'Set admin password') : t('管理登录', 'Admin sign-in')}
            </CardTitle>
            <CardDescription>
              {firstTime
                ? t('首次进入管理页，请设置一个管理密码。', 'First visit — set an admin password to protect the console.')
                : t('输入管理密码以进入母号管理。', 'Enter the admin password to manage team accounts.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (password) mutate.mutate()
              }}
            >
              <div className="space-y-1.5">
                <label htmlFor="admin-password" className="text-[13px] font-semibold">
                  {t('管理密码', 'Admin password')}
                </label>
                <div className="relative">
                  <Input
                    id="admin-password"
                    type={show ? 'text' : 'password'}
                    value={password}
                    autoFocus
                    autoComplete={firstTime ? 'new-password' : 'current-password'}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={firstTime ? t('至少 4 位', 'At least 4 characters') : '••••••••'}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={show ? t('隐藏', 'Hide') : t('显示', 'Show')}
                  >
                    {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
              </div>

              {mutate.isError && (
                <p className="text-sm text-destructive-foreground">{extractError(mutate.error)}</p>
              )}

              <Button type="submit" className="w-full" disabled={!password || mutate.isPending}>
                {mutate.isPending ? t('处理中…', 'Working…') : firstTime ? t('设置并进入', 'Set & enter') : t('登录', 'Sign in')}
                <ArrowRightIcon className="size-4" />
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          <a href="#/" className="hover:text-foreground">
            {t('← 返回用户提交页', '← Back to user page')}
          </a>
        </p>
      </div>
    </div>
  )
}
