/**
 * 浏览器侧粗解 access_token，仅用于提交前给用户一个「将为 xxx 执行」的预览与即时纠错。
 * 与后端 `jwt.rs` 同一套 claim；**不做判决**——真正的校验在后端与上游。
 */
export interface TokenPreview {
  email: string | null
  name: string | null
  planType: string | null
  userId: string | null
  /** Unix 秒；缺失为 null。 */
  exp: number | null
}

const ISSUER = 'https://auth.openai.com'

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  // atob 给的是 latin1 字节串，按 UTF-8 还原（邮箱/姓名可能含非 ASCII）。
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * 把粘进来的东西规整成裸 token，与后端 `jwt::extract_token` 同规则：
 * 整段 session JSON（取 accessToken）、带 Bearer 前缀、被引号包着，都认。
 */
export function extractToken(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('{')) {
    try {
      const v = JSON.parse(s) as Record<string, unknown>
      const t = v.accessToken ?? v.access_token
      if (typeof t === 'string') return t.trim()
    } catch {
      const m = /"accessToken"\s*:\s*"([^"]+)"/.exec(s)
      if (m) return m[1].trim()
    }
  }
  s = s.replace(/^[Bb]earer\s+/, '')
  return s.replace(/^["',]+|["',]+$/g, '').trim()
}

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g

/**
 * 从一段文本里找出所有 access_token，去重后按出现顺序返回——批量提交的入口。
 *
 * 不按行拆：用户可能把好几段 session JSON 连着粘、或者一行里逗号隔开好几个 token，行边界
 * 不可靠；直接按 JWT 的形态（`eyJ` 开头的三段 base64url）扫描最稳。整段 session JSON 里
 * 只有 accessToken 一处是 JWT，所以扫出来的就是它。一个都没扫到时退回单条的宽松规整逻辑，
 * 让后续 [`previewToken`] 报出「格式不对」而不是这里静默吞掉。
 */
export function splitTokens(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of raw.match(JWT_RE) ?? []) {
    if (!seen.has(tok)) {
      seen.add(tok)
      out.push(tok)
    }
  }
  if (out.length === 0) {
    const one = extractToken(raw)
    if (one) out.push(one)
  }
  return out
}

/** 解析失败返回 `{ error }`，成功返回 `{ preview }`。 */
export function previewToken(raw: string): { preview: TokenPreview } | { error: 'format' | 'issuer' } {
  const token = extractToken(raw)
  const parts = token.split('.')
  if (parts.length !== 3) return { error: 'format' }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>
  } catch {
    return { error: 'format' }
  }
  if (payload.iss !== ISSUER) return { error: 'issuer' }
  const auth = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>
  const profile = (payload['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    preview: {
      email: str(profile.email),
      name: str(profile.name),
      planType: str(auth.chatgpt_plan_type),
      userId: str(auth.chatgpt_user_id),
      exp: typeof payload.exp === 'number' ? payload.exp : null,
    },
  }
}
