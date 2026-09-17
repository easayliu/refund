import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangleIcon, CheckCircle2Icon, ClipboardPasteIcon, ExternalLinkIcon, HourglassIcon,
  LockIcon, LogInIcon, MailPlusIcon, ShieldCheckIcon, UserMinusIcon, UsersIcon, XCircleIcon, XIcon,
} from 'lucide-react'
import { getJob, getServiceStatus, submitRefund } from '@/api/refund'
import type { Job } from '@/api/admin'
import { extractError } from '@/lib/utils'
import { previewToken } from '@/lib/jwt'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { StepList } from '@/components/step-list'
import { AppHeader } from '@/components/app-header'
import { AppFooter } from '@/components/app-footer'
import { useI18n } from '@/lib/i18n'

/**
 * 进行中的任务 id 记在 localStorage：用户提交后刷新页面（或误关标签页再打开）还能接着看进度，
 * 而不是丢了 id 就只能重新提交——重新提交会被后端按同用户去重，但用户并不知道这一点。
 */
const JOB_KEY = 'refund_job_id'
const readJobId = (): number | null => {
  try {
    const v = localStorage.getItem(JOB_KEY)
    return v ? Number(v) || null : null
  } catch {
    return null
  }
}
const writeJobId = (id: number | null) => {
  try {
    if (id == null) localStorage.removeItem(JOB_KEY)
    else localStorage.setItem(JOB_KEY, String(id))
  } catch {
    // ignore
  }
}

const SESSION_URL = 'https://chatgpt.com/api/auth/session'

type HttpErr = { response?: { status?: number } }

/**
 * 用户提交页（公开）。布局对齐 Cloudflare 控制台：页头标题区 + 两栏——左侧是主操作卡片
 * （提交表单 / 执行进度），右侧是说明卡片（获取 token、流程说明、排队规则）。
 */
export function UserPage() {
  const { t } = useI18n()
  const [userAt, setUserAt] = useState('')
  const [jobId, setJobId] = useState<number | null>(readJobId)

  useEffect(() => {
    document.title = t('去除个人空间 · refund', 'Remove personal space · refund')
  }, [t])

  const status = useQuery({ queryKey: ['service-status'], queryFn: getServiceStatus, refetchInterval: 15_000 })
  const notReady = status.data != null && !status.data.ready

  // 提交前本地粗解 token：给用户一个「将为谁执行」的确认，粘错了立刻能看出来。
  const parsed = useMemo(() => (userAt.trim() ? previewToken(userAt) : null), [userAt])
  const preview = parsed && 'preview' in parsed ? parsed.preview : null
  const parseError = parsed && 'error' in parsed ? parsed.error : null
  const expired = preview?.exp != null && preview.exp * 1000 < Date.now()

  const submit = useMutation({
    mutationFn: () => submitRefund(userAt.trim()),
    onSuccess: (data) => {
      writeJobId(data.job_id)
      setJobId(data.job_id)
    },
  })

  // 提交后轮询任务，直到 success/failed 停下。排队中轮询慢一点，执行中快一点。
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId as number),
    enabled: jobId != null,
    retry: (count, err) => (err as HttpErr)?.response?.status !== 404 && count < 3,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      if (s === 'success' || s === 'failed') return false
      return s === 'pending' ? 3000 : 1500
    },
  })

  // 记住的任务 id 已经查不到（库被清了）→ 当作没有任务，回到表单。
  useEffect(() => {
    if (job.isError && (job.error as HttpErr)?.response?.status === 404) {
      writeJobId(null)
      setJobId(null)
    }
  }, [job.isError, job.error])

  const current: Job | undefined = job.data
  const done = current?.status === 'success' || current?.status === 'failed'

  const reset = () => {
    writeJobId(null)
    setJobId(null)
    setUserAt('')
    submit.reset()
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setUserAt(text)
    } catch {
      // 剪贴板权限被拒时静默，用户手动粘贴即可。
    }
  }

  const canSubmit = !!preview && !expired && !submit.isPending && !notReady

  return (
    <div className="app-shell flex min-h-dvh flex-col text-foreground">
      <AppHeader
        subtitle={t('去除个人空间', 'Personal-Space Remover')}
        actions={
          <a
            href="#/admin"
            className="inline-flex h-9 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ShieldCheckIcon className="size-4" />
            {t('管理', 'Admin')}
          </a>
        }
      />

      <main className="page-frame flex-1 py-6 sm:py-8">
        {/* 标题区 */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t('去除个人空间', 'Remove personal space')}</h1>
            <p className="text-sm text-muted-foreground">
              {t(
                '提交你的 access_token，系统自动把你拉进团队、去除个人空间，再移出团队。',
                'Submit your access_token. We add you to a team, remove your personal space, then remove you from the team.',
              )}
            </p>
          </div>
          <div className="self-start sm:self-auto">
            <ServiceBadge ready={status.data?.ready} />
          </div>
        </div>

        {notReady && (
          <div className="mb-5 flex items-start gap-2.5 rounded-md border border-warning/50 bg-warning/8 px-4 py-3 text-sm">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <span className="font-semibold text-warning-foreground">{t('服务未就绪。', 'Service not ready.')}</span>{' '}
              <span className="text-muted-foreground">
                {t('管理员尚未配置母号，暂时无法提交，页面会自动重试。', 'No team account is configured yet. This page re-checks automatically.')}
              </span>
            </div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          {/* 左栏：主操作 */}
          <div className="min-w-0 space-y-5">
            {!jobId && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('提交 access_token', 'Submit access_token')}</CardTitle>
                  <CardDescription>
                    {t(
                      '可直接粘贴 chatgpt.com/api/auth/session 返回的整段 JSON，系统会自动取出 accessToken。',
                      'You can paste the whole JSON from chatgpt.com/api/auth/session; the accessToken is picked out automatically.',
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="user-at" className="text-[13px] font-semibold">
                      access_token
                    </label>
                    <div className="relative">
                      <Textarea
                        id="user-at"
                        value={userAt}
                        onChange={(e) => setUserAt(e.target.value)}
                        placeholder={t('eyJhbGciOi... 或整段 session JSON', 'eyJhbGciOi... or the whole session JSON')}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        aria-invalid={!!parseError || expired}
                        className="min-h-32 resize-y break-all pr-10 text-xs leading-relaxed"
                      />
                      <div className="absolute end-1.5 top-1.5">
                        {userAt ? (
                          <IconButton label={t('清空', 'Clear')} onClick={() => setUserAt('')}>
                            <XIcon className="size-3.5" />
                          </IconButton>
                        ) : (
                          <IconButton label={t('从剪贴板粘贴', 'Paste from clipboard')} onClick={paste}>
                            <ClipboardPasteIcon className="size-3.5" />
                          </IconButton>
                        )}
                      </div>
                    </div>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <LockIcon className="size-3" />
                      {t('token 只用于本次流程，不会被保存。', 'Used for this run only. Never stored.')}
                    </p>
                  </div>

                  {preview && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-sm border bg-surface px-4 py-3 text-[13px]">
                      <dt className="text-muted-foreground">{t('账号', 'Account')}</dt>
                      <dd className="min-w-0 truncate font-medium">
                        {preview.email ?? preview.name ?? preview.userId ?? t('未知', 'unknown')}
                      </dd>
                      <dt className="text-muted-foreground">{t('套餐', 'Plan')}</dt>
                      <dd>{preview.planType ? <Badge tone="info" dot={false}>{preview.planType}</Badge> : '-'}</dd>
                      <dt className="text-muted-foreground">{t('状态', 'Status')}</dt>
                      <dd>
                        {expired ? (
                          <Badge tone="destructive">{t('token 已过期', 'Expired')}</Badge>
                        ) : !preview.email ? (
                          <Badge tone="destructive">{t('缺少邮箱，无法执行', 'No email in token')}</Badge>
                        ) : (
                          <Badge tone="success">{t('可以执行', 'Ready')}</Badge>
                        )}
                      </dd>
                    </dl>
                  )}
                  {parseError && (
                    <p className="text-[13px] text-destructive-foreground">
                      {parseError === 'issuer'
                        ? t('这不是 ChatGPT 的 access_token（签发方不对）。', 'Not a ChatGPT access_token (wrong issuer).')
                        : t('看起来不是完整的 access_token，请检查是否复制完整。', 'This does not look like a complete access_token. Check the copy.')}
                    </p>
                  )}
                  {submit.isError && (
                    <p className="text-[13px] text-destructive-foreground">{extractError(submit.error)}</p>
                  )}
                </CardContent>
                <CardFooter className="justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t('同一母号上的任务按提交顺序依次执行。', 'Jobs on the same team run one at a time in order.')}
                  </span>
                  <Button disabled={!canSubmit} onClick={() => submit.mutate()}>
                    {submit.isPending ? t('提交中…', 'Submitting…') : t('开始执行', 'Start')}
                  </Button>
                </CardFooter>
              </Card>
            )}

            {jobId && !current && !job.isError && (
              <Card>
                <CardContent className="flex items-center gap-2.5 py-6 text-sm text-muted-foreground">
                  <HourglassIcon className="size-4 animate-pulse" />
                  {t('正在读取任务…', 'Loading job…')}
                </CardContent>
              </Card>
            )}

            {jobId && current && (
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <div className="min-w-0 space-y-1">
                    <CardTitle>{t('执行进度', 'Progress')}</CardTitle>
                    <CardDescription className="truncate">
                      #{current.id}
                      {current.user_email ? ` · ${current.user_email}` : ''}
                    </CardDescription>
                  </div>
                  <ResultBadge status={current.status} />
                </CardHeader>
                <CardContent className="space-y-5">
                  {current.status === 'pending' && (
                    <div className="flex items-start gap-2.5 rounded-sm border bg-surface px-4 py-3 text-sm">
                      <UsersIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="space-y-0.5">
                        <div className="font-semibold">
                          {(current.queue_ahead ?? 0) > 0
                            ? t(`排队中，前面还有 ${current.queue_ahead} 个任务`, `Queued — ${current.queue_ahead} job(s) ahead of you`)
                            : t('排队中，即将开始', 'Queued — starting shortly')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('可以关掉页面，回来后进度会自动恢复。', 'You can close this page; progress resumes when you return.')}
                        </div>
                      </div>
                    </div>
                  )}

                  <StepList job={current} />

                  {done && (
                    <div
                      className={
                        'flex items-start gap-2.5 rounded-sm border px-4 py-3 text-sm ' +
                        (current.status === 'success'
                          ? 'border-success/40 bg-success/8 text-success-foreground'
                          : 'border-destructive/40 bg-destructive/8 text-destructive-foreground')
                      }
                    >
                      {current.status === 'success' ? (
                        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
                      ) : (
                        <XCircleIcon className="mt-0.5 size-4 shrink-0" />
                      )}
                      <span>
                        {current.status === 'success'
                          ? t('全部完成：已去除个人空间并移出团队。', 'Done: personal space removed and account kicked.')
                          : t('流程未完成，请查看上方步骤的错误信息；确认 token 有效后可重新提交。', 'Flow did not finish. See the step errors above, check the token and submit again.')}
                      </span>
                    </div>
                  )}
                </CardContent>
                {done && (
                  <CardFooter>
                    <Button variant="outline" onClick={reset}>
                      {current.status === 'success' ? t('再提交一个', 'Submit another') : t('重新提交', 'Try again')}
                    </Button>
                  </CardFooter>
                )}
              </Card>
            )}
          </div>

          {/* 右栏：说明 */}
          <aside className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('如何获取 access_token', 'How to get the access_token')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 text-[13px]">
                  <HelpStep n={1}>
                    {t('在已登录 ChatGPT 的浏览器里打开', 'In a browser signed in to ChatGPT, open')}{' '}
                    <a
                      href={SESSION_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 break-all font-mono text-xs text-link hover:underline"
                    >
                      chatgpt.com/api/auth/session
                      <ExternalLinkIcon className="size-3 shrink-0" />
                    </a>
                  </HelpStep>
                  <HelpStep n={2}>
                    {t('全选复制页面上的整段 JSON。', 'Select all and copy the whole JSON on that page.')}
                  </HelpStep>
                  <HelpStep n={3}>
                    {t('粘贴到左侧输入框，确认账号无误后开始。', 'Paste it into the box on the left, check the account, and start.')}
                  </HelpStep>
                </ol>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('会发生什么', 'What happens')}</CardTitle>
              </CardHeader>
              <CardContent>
                <FlowOverview />
              </CardContent>
              <CardFooter className="justify-start text-xs text-muted-foreground">
                {t('全程约半分钟；同一母号上的任务依次执行，高峰期需要排队。', 'About half a minute. Jobs on the same team run one at a time.')}
              </CardFooter>
            </Card>
          </aside>
        </div>
      </main>

      <AppFooter />
    </div>
  )
}

function ServiceBadge({ ready }: { ready: boolean | undefined }) {
  const { t } = useI18n()
  if (ready == null) return null
  return ready ? (
    <Badge tone="success">{t('服务正常', 'Operational')}</Badge>
  ) : (
    <Badge tone="warning">{t('服务未就绪', 'Not ready')}</Badge>
  )
}

function HelpStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
        {n}
      </span>
      <span className="min-w-0 leading-relaxed text-muted-foreground">{children}</span>
    </li>
  )
}

/** 四步流程一览：纵向时间线。 */
function FlowOverview() {
  const { t } = useI18n()
  const steps = [
    { icon: MailPlusIcon, label: t('邀请加入团队', 'Invite to team'), hint: t('母号向你的邮箱发出邀请', 'The team invites your email') },
    { icon: LogInIcon, label: t('接受邀请', 'Accept invite'), hint: t('用你的 token 自动接受', 'Accepted with your token') },
    { icon: UsersIcon, label: t('去除个人空间', 'Remove personal space'), hint: t('个人空间转移到团队', 'Personal space moves to the team') },
    { icon: UserMinusIcon, label: t('移出团队', 'Kick from team'), hint: t('流程结束，母号把你移出', 'The team removes you at the end') },
  ]
  return (
    <ol className="relative space-y-4 before:absolute before:inset-y-2 before:start-[11px] before:w-px before:bg-border">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-3">
          <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground">
            <s.icon className="size-3" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-6">{s.label}</div>
            <div className="text-xs text-muted-foreground">{s.hint}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

function ResultBadge({ status }: { status: Job['status'] }) {
  const { t } = useI18n()
  if (status === 'success') return <Badge tone="success">{t('成功', 'Success')}</Badge>
  if (status === 'failed') return <Badge tone="destructive">{t('失败', 'Failed')}</Badge>
  if (status === 'running') return <Badge tone="info">{t('执行中', 'Running')}</Badge>
  return <Badge tone="warning">{t('排队中', 'Queued')}</Badge>
}
