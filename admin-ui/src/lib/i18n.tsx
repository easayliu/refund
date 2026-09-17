import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type Language = 'zh' | 'en'
const KEY = 'refund.language'

interface I18nValue {
  language: Language
  setLanguage: (l: Language) => void
  /** 传中英两版，按当前语言取一版。 */
  t: (zh: string, en: string) => string
}

const I18nContext = createContext<I18nValue | null>(null)

function initial(): Language {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'en') return 'en'
    if (v === 'zh') return 'zh'
  } catch {
    // ignore
  }
  return 'zh'
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLang] = useState<Language>(initial)
  const setLanguage = useCallback((l: Language) => {
    setLang(l)
    try {
      localStorage.setItem(KEY, l)
    } catch {
      // ignore
    }
    document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN'
  }, [])
  const t = useCallback((zh: string, en: string) => (language === 'en' ? en : zh), [language])
  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 LanguageProvider 内使用')
  return ctx
}
