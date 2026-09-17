/** 主题：跟随系统 / 浅色 / 深色三态，选择存 localStorage。 */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'refund.theme'

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // localStorage 不可用（隐私模式等）时退回跟随系统。
  }
  return 'system'
}

function systemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // 存不了就只作用于本次会话。
  }
  apply(theme)
}

/** 渲染前调用：还原保存的主题，并监听系统切换（仅 system 态响应）。 */
export function initTheme() {
  apply(getTheme())
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') apply('system')
  })
}
