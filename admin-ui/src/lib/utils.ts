import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind 类名合并。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 从 axios 错误里抠出后端返回的可读信息，退回通用文案。 */
export function extractError(err: unknown, fallback = '请求失败'): string {
  const e = err as { response?: { data?: unknown }; message?: string }
  const data = e?.response?.data
  if (typeof data === 'string' && data.trim()) return data
  if (data && typeof data === 'object') {
    const m = (data as Record<string, unknown>).error ?? (data as Record<string, unknown>).message
    if (typeof m === 'string' && m.trim()) return m
  }
  return e?.message || fallback
}

/** Unix 秒 → 本地日期时间。 */
export function fmtTime(unixSecs: number): string {
  if (!unixSecs) return '-'
  return new Date(unixSecs * 1000).toLocaleString()
}
