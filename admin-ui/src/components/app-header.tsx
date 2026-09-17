import type { ReactNode } from 'react'
import { LanguageSwitcher } from '@/components/language-switcher'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { LogoMark } from '@/components/logo-mark'

/**
 * 顶栏：白底、底边 1px、左侧橙色品牌标识 + 名称，右侧语言/主题与页面自己的操作。
 * 用户页与管理页共用，保证两边顶栏对齐。
 */
export function AppHeader({ subtitle, actions }: { subtitle: string; actions?: ReactNode }) {
  return (
    <header className="app-header sticky top-0 z-20 border-b bg-card">
      <div className="page-frame flex h-14 items-center justify-between gap-3">
        <a href="#/" className="flex min-w-0 items-center gap-2.5">
          <div className="brand-mark flex size-8 shrink-0 items-center justify-center rounded-sm">
            <LogoMark className="size-[1.125rem]" />
          </div>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-[15px] font-semibold leading-none tracking-tight">refund</span>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">{subtitle}</span>
          </div>
        </a>
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeSwitcher />
          {actions && <div className="ms-1 flex items-center gap-1 border-s ps-2">{actions}</div>}
        </div>
      </div>
    </header>
  )
}
