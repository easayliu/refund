import { LanguagesIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** 语言切换：中 ↔ 英。 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { language, setLanguage } = useI18n()
  return (
    <button
      onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
      aria-label="切换语言"
    >
      <LanguagesIcon className="size-4" />
      {language === 'en' ? 'EN' : '中'}
    </button>
  )
}
