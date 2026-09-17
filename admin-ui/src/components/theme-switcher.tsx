import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useState } from 'react'

const order: Theme[] = ['system', 'light', 'dark']
const icons = { system: MonitorIcon, light: SunIcon, dark: MoonIcon }

/** 主题切换：点击在 系统→浅→深 之间轮转。 */
export function ThemeSwitcher({ className }: { className?: string }) {
  const [theme, setLocal] = useState<Theme>(getTheme())
  const Icon = icons[theme]
  const next = () => {
    const t = order[(order.indexOf(theme) + 1) % order.length]
    setTheme(t)
    setLocal(t)
  }
  return (
    <button
      onClick={next}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
      aria-label="切换主题"
      title={theme}
    >
      <Icon className="size-4" />
    </button>
  )
}
