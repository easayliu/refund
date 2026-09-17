import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangleIcon, CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, ClipboardPasteIcon, ExternalLinkIcon,
  HourglassIcon, LayersIcon, LockIcon, LogInIcon, MailPlusIcon, ShieldCheckIcon, UserMinusIcon, UsersIcon,
  UploadIcon, XCircleIcon, XIcon,
} from 'lucide-react'
import { getJob, getJobs, getServiceStatus, submitRefund, submitRefundBatch } from '@/api/refund'
import type { Job } from '@/api/admin'
import { extractError } from '@/lib/utils'
import { previewToken, splitTokens, type TokenPreview } from '@/lib/jwt'
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

/**
 * 批量提交的一条：提交前就定下的账号标识 + 提交后的任务 id（或本地/后端给出的失败原因）。
 * 整批记在 localStorage（`refund_batch`），与单条的 `refund_job_id` 互斥——同一时刻用户页
 * 只看一种进度视图。
 */
interface BatchEntry {
  label: string
  plan: string | null
  jobId: number | null
  error: string | null
}
const BATCH_KEY = 'refund_batch'
const readBatch = (): BatchEntry[] | null => {
  try {
    const v = localStorage.getItem(BATCH_KEY)
    if (!v) return null
    const arr = JSON.parse(v) as BatchEntry[]
    return Array.isArray(arr) && arr.length > 0 ? arr : null
  } catch {
    return null
  }
}
const writeBatch = (entries: BatchEntry[] | null) => {
  try {
    if (!entries) localStorage.removeItem(BATCH_KEY)
    else localStorage.setItem(BATCH_KEY, JSON.stringify(entries))
  } catch {
    // ignore
  }
}

/** 后端一次批量提交的上限，与 `web.rs` 的 `MAX_BATCH` 一致；超出的在前端就拦。 */
const MAX_BATCH = 50

/**
 * 上传文件的接受类型与单文件大小上限。文件只在浏览器里读成文本、丢进输入框，不会上传到
 * 服务端——服务端从头到尾只见到扫出来的 token。50 个 session JSON 也不过几百 KB，2 MB 足够；
 * 再大多半是拖错了文件，直接拒掉比把整页卡死好。
 */
const FILE_ACCEPT = '.txt,.json,.csv,.log,text/plain,application/json'
const MAX_FILE_BYTES = 2 * 1024 * 1024

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
  const [batch, setBatch] = useState<BatchEntry[] | null>(readBatch)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = t('去除个人空间 · refund', 'Remove personal space · refund')
  }, [t])

  const status = useQuery({ queryKey: ['service-status'], queryFn: getServiceStatus, refetchInterval: 15_000 })
  const notReady = status.data != null && !status.data.ready

  // 输入框里可能粘了一个或多个 token：扫出来后按条数决定走单条还是批量。
  const tokens = useMemo(() => (userAt.trim() ? splitTokens(userAt) : []), [userAt])
  const isBatch = tokens.length > 1

  // 提交前本地粗解 token：给用户一个「将为谁执行」的确认，粘错了立刻能看出来。
  const parsed = useMemo(() => (tokens.length === 1 ? previewToken(tokens[0]) : null), [tokens])
  const preview = parsed && 'preview' in parsed ? parsed.preview : null
  const parseError = parsed && 'error' in parsed ? parsed.error : null
  const expired = preview?.exp != null && preview.exp * 1000 < Date.now()

  // 批量：逐条预检，能提交的和本地就能判死的分开。后者不发给后端，直接以失败原因入列。
  const rows = useMemo(() => (isBatch ? tokens.map((tok) => precheck(tok, t)) : []), [tokens, isBatch, t])
  const readyRows = rows.filter((r) => r.error == null)
  const overLimit = readyRows.length > MAX_BATCH

  const submit = useMutation({
    mutationFn: () => submitRefund(tokens[0]),
    onSuccess: (data) => {
      writeJobId(data.job_id)
      setJobId(data.job_id)
    },
  })

  const submitBatch = useMutation({
    mutationFn: async () => {
      const ats = readyRows.map((r) => r.token)
      const results = await submitRefundBatch(ats)
      // 把后端按位置返回的结果贴回对应行；本地预检失败的行原样保留失败原因。
      const byIndex = new Map(results.map((r) => [r.index, r]))
      let sent = 0
      const entries: BatchEntry[] = rows.map((r) => {
        if (r.error != null) return { label: r.label, plan: r.plan, jobId: null, error: r.error }
        const res = byIndex.get(sent++)
        return {
          label: r.label,
          plan: r.plan,
          jobId: res?.job_id ?? null,
          error: res?.job_id != null ? null : (res?.error ?? t('未返回结果', 'No result returned')),
        }
      })
      return entries
    },
    onSuccess: (entries) => {
      writeBatch(entries)
      setBatch(entries)
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

  // 批量：一次轮询整批 id，任一未完成就继续。
  const batchIds = useMemo(() => (batch ?? []).map((e) => e.jobId).filter((id): id is number => id != null), [batch])
  const batchJobs = useQuery({
    queryKey: ['jobs', batchIds],
    queryFn: () => getJobs(batchIds),
    enabled: batchIds.length > 0,
    refetchInterval: (q) => {
      const list = q.state.data
      if (!list) return 2000
      // 返回里缺的 id（库被清了）也当已结束，别为它们永远轮询。
      const unfinished = list.some((j) => j.status === 'pending' || j.status === 'running')
      return unfinished ? 2000 : false
    },
  })
  const jobById = useMemo(() => new Map((batchJobs.data ?? []).map((j) => [j.id, j])), [batchJobs.data])
  const batchDone =
    batch != null &&
    batchIds.length > 0 &&
    batchJobs.data != null &&
    batchIds.every((id) => {
      const j = jobById.get(id)
      return !j || j.status === 'success' || j.status === 'failed'
    })
  // 全部本地预检都没过、一条都没发出去：没有可轮询的，直接算结束。
  const batchAllLocalFail = batch != null && batchIds.length === 0

  const reset = () => {
    writeJobId(null)
    setJobId(null)
    writeBatch(null)
    setBatch(null)
    setUserAt('')
    submit.reset()
    submitBatch.reset()
  }

  /**
   * 读入一批文件，把文本追加到输入框末尾（换行隔开）。追加而不是替换：用户可能先粘了几个、
   * 再补一个文件。逐个读，读不了的（二进制、超限）记一条错误，其余照常。
   */
  const ingestFiles = async (files: FileList | File[]) => {
    const errs: string[] = []
    let text = ''
    for (const f of Array.from(files)) {
      if (f.size > MAX_FILE_BYTES) {
        errs.push(t(`${f.name}：超过 2 MB`, `${f.name}: over 2 MB`))
        continue
      }
      try {
        text += (text ? '\n' : '') + (await f.text())
      } catch {
        errs.push(t(`${f.name}：读取失败`, `${f.name}: could not read`))
      }
    }
    if (text) setUserAt((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text))
    setFileError(errs.length ? errs.join('；') : null)
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
  const canSubmitBatch = readyRows.length > 0 && !overLimit && !submitBatch.isPending && !notReady
  const showForm = !jobId && !batch

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
            {showForm && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('提交 access_token', 'Submit access_token')}</CardTitle>
                  <CardDescription>
                    {t('可粘贴整段 session JSON；多个 token 会自动按批量执行。', 'Paste the whole session JSON; several tokens run as a batch.')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="user-at" className="text-[13px] font-semibold">
                      access_token
                    </label>
                    <div
                      className={'relative rounded-sm ' + (dragging ? 'ring-2 ring-ring/40' : '')}
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDragging(true)
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragging(false)
                        if (e.dataTransfer.files.length) void ingestFiles(e.dataTransfer.files)
                      }}
                    >
                      <Textarea
                        id="user-at"
                        value={userAt}
                        onChange={(e) => setUserAt(e.target.value)}
                        placeholder={t('eyJhbGciOi... 或整段 session JSON', 'eyJhbGciOi... or the whole session JSON')}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        aria-invalid={(!!parseError || expired) && !isBatch}
                        className="min-h-32 resize-y break-all pr-10 text-xs leading-relaxed"
                      />
                      <div className="absolute end-1.5 top-1.5 flex items-center gap-0.5">
                        <IconButton label={t('上传文件（txt / json / csv）', 'Upload file (txt / json / csv)')} onClick={() => fileInput.current?.click()}>
                          <UploadIcon className="size-3.5" />
                        </IconButton>
                        {userAt ? (
                          <IconButton
                            label={t('清空', 'Clear')}
                            onClick={() => {
                              setUserAt('')
                              setFileError(null)
                            }}
                          >
                            <XIcon className="size-3.5" />
                          </IconButton>
                        ) : (
                          <IconButton label={t('从剪贴板粘贴', 'Paste from clipboard')} onClick={paste}>
                            <ClipboardPasteIcon className="size-3.5" />
                          </IconButton>
                        )}
                      </div>
                      <input
                        ref={fileInput}
                        type="file"
                        accept={FILE_ACCEPT}
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.length) void ingestFiles(e.target.files)
                          // 清掉选择，同一个文件再选一次也能触发 onChange。
                          e.target.value = ''
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <LockIcon className="size-3" />
                        {t('token 只用于本次流程，不会被保存。', 'Used for this run only. Never stored.')}
                      </span>
                      <span>{t('也可把 txt / json / csv 文件拖到框里，或点右上角上传。', 'Or drop a txt / json / csv file here, or use the upload button.')}</span>
                    </div>
                    {fileError && <p className="text-[13px] text-destructive-foreground">{fileError}</p>}
                  </div>

                  {isBatch && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-[13px]">
                        <LayersIcon className="size-4 text-muted-foreground" />
                        <span className="font-semibold">
                          {t(`识别到 ${rows.length} 个 token`, `${rows.length} tokens detected`)}
                        </span>
                        <span className="text-muted-foreground">
                          {t(`可执行 ${readyRows.length} 个`, `${readyRows.length} ready`)}
                          {rows.length - readyRows.length > 0 &&
                            t(`，${rows.length - readyRows.length} 个无法执行`, `, ${rows.length - readyRows.length} invalid`)}
                        </span>
                      </div>
                      <div className="overflow-x-auto rounded-sm border">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th className="w-8">#</th>
                              <th>{t('账号', 'Account')}</th>
                              <th>{t('套餐', 'Plan')}</th>
                              <th>{t('状态', 'Status')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r, i) => (
                              <tr key={i}>
                                <td className="tabular-nums text-muted-foreground">{i + 1}</td>
                                <td className="max-w-[16rem] truncate font-medium">{r.label}</td>
                                <td>{r.plan ? <Badge tone="info" dot={false}>{r.plan}</Badge> : '-'}</td>
                                <td>
                                  {r.error ? (
                                    <Badge tone="destructive">{r.error}</Badge>
                                  ) : (
                                    <Badge tone="success">{t('可以执行', 'Ready')}</Badge>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {overLimit && (
                        <p className="text-[13px] text-destructive-foreground">
                          {t(`一次最多提交 ${MAX_BATCH} 个，请分批。`, `At most ${MAX_BATCH} per batch. Please split them up.`)}
                        </p>
                      )}
                    </div>
                  )}

                  {!isBatch && preview && (
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
                  {!isBatch && parseError && (
                    <p className="text-[13px] text-destructive-foreground">
                      {parseError === 'issuer'
                        ? t('这不是 ChatGPT 的 access_token（签发方不对）。', 'Not a ChatGPT access_token (wrong issuer).')
                        : t('看起来不是完整的 access_token，请检查是否复制完整。', 'This does not look like a complete access_token. Check the copy.')}
                    </p>
                  )}
                  {submit.isError && (
                    <p className="text-[13px] text-destructive-foreground">{extractError(submit.error)}</p>
                  )}
                  {submitBatch.isError && (
                    <p className="text-[13px] text-destructive-foreground">{extractError(submitBatch.error)}</p>
                  )}
                </CardContent>
                <CardFooter className="justify-between">
                  <span className="text-xs text-muted-foreground">
                    {isBatch
                      ? t('多个账号会分散到不同母号并行执行；同一母号上依次执行。', 'Accounts are spread across team accounts; jobs on one team run in order.')
                      : t('同一母号上的任务按提交顺序依次执行。', 'Jobs on the same team run one at a time in order.')}
                  </span>
                  {isBatch ? (
                    <Button disabled={!canSubmitBatch} onClick={() => submitBatch.mutate()}>
                      {submitBatch.isPending
                        ? t('提交中…', 'Submitting…')
                        : t(`批量执行 ${readyRows.length} 个`, `Start ${readyRows.length} jobs`)}
                    </Button>
                  ) : (
                    <Button disabled={!canSubmit} onClick={() => submit.mutate()}>
                      {submit.isPending ? t('提交中…', 'Submitting…') : t('开始执行', 'Start')}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            )}

            {batch && (
              <BatchProgress
                entries={batch}
                jobById={jobById}
                loading={batchIds.length > 0 && batchJobs.data == null && !batchJobs.isError}
                done={batchDone || batchAllLocalFail}
                onReset={reset}
              />
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
                    {t('粘贴到左侧输入框，确认账号无误后开始。要批量处理，把多个账号的 JSON 依次粘进同一个框，或上传一个每行一条的 txt / json / csv 文件。', 'Paste it into the box on the left, check the account, and start. For a batch, paste several accounts\u2019 JSON into the same box, or upload a txt / json / csv file with one token per line.')}
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

/** 批量提交前的一行：能提交就带 token，本地就能判死的带 error。 */
interface PrecheckRow {
  token: string
  label: string
  plan: string | null
  error: string | null
}

/**
 * 与单条模式同一套前端预检（格式 / 签发方 / 过期 / 缺邮箱），只是把结论压成一行文案。
 * 判死的行不发给后端——后端不查过期，放过去只会在接受邀请那一步 401，用户看到的是一个
 * 跑了半截的失败任务，不如提交前就标出来。
 */
function precheck(token: string, t: (zh: string, en: string) => string): PrecheckRow {
  const parsed = previewToken(token)
  if ('error' in parsed) {
    const short = token.length > 14 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token
    return {
      token,
      label: short,
      plan: null,
      error: parsed.error === 'issuer' ? t('签发方不对', 'Wrong issuer') : t('格式不完整', 'Malformed'),
    }
  }
  const p: TokenPreview = parsed.preview
  const label = p.email ?? p.name ?? p.userId ?? t('未知', 'unknown')
  if (p.exp != null && p.exp * 1000 < Date.now()) return { token, label, plan: p.planType, error: t('已过期', 'Expired') }
  if (!p.email) return { token, label, plan: p.planType, error: t('缺少邮箱', 'No email') }
  return { token, label, plan: p.planType, error: null }
}

/** 批量进度：一张表，每行一个账号，点开看四步日志；全部结束后给汇总与「再提交一批」。 */
function BatchProgress({
  entries,
  jobById,
  loading,
  done,
  onReset,
}: {
  entries: BatchEntry[]
  jobById: Map<number, Job>
  loading: boolean
  done: boolean
  onReset: () => void
}) {
  const { t } = useI18n()
  const statusOf = (e: BatchEntry): Job['status'] | 'error' | 'missing' => {
    if (e.jobId == null) return 'error'
    const j = jobById.get(e.jobId)
    return j ? j.status : 'missing'
  }
  const counts = entries.reduce(
    (acc, e) => {
      const s = statusOf(e)
      if (s === 'success') acc.success++
      else if (s === 'failed' || s === 'error' || s === 'missing') acc.failed++
      else acc.active++
      return acc
    },
    { success: 0, failed: 0, active: 0 },
  )

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>{t('批量执行进度', 'Batch progress')}</CardTitle>
          <CardDescription>
            {t(`共 ${entries.length} 个`, `${entries.length} total`)}
            {' · '}
            {t(`成功 ${counts.success}`, `${counts.success} succeeded`)}
            {' · '}
            {t(`失败 ${counts.failed}`, `${counts.failed} failed`)}
            {counts.active > 0 && ` · ${t(`进行中 ${counts.active}`, `${counts.active} in progress`)}`}
          </CardDescription>
        </div>
        {done ? (
          counts.failed === 0 ? (
            <Badge tone="success">{t('全部完成', 'All done')}</Badge>
          ) : (
            <Badge tone="warning">{t('已结束，有失败', 'Finished with failures')}</Badge>
          )
        ) : (
          <Badge tone="info">{t('执行中', 'Running')}</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2.5 py-2 text-sm text-muted-foreground">
            <HourglassIcon className="size-4 animate-pulse" />
            {t('正在读取任务…', 'Loading jobs…')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-sm border">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-8" />
                  <th className="w-8">#</th>
                  <th>{t('账号', 'Account')}</th>
                  <th>{t('状态', 'Status')}</th>
                  <th>{t('排队', 'Queue')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <BatchRow key={i} index={i} entry={e} job={e.jobId != null ? jobById.get(e.jobId) : undefined} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!done && (
          <p className="text-xs text-muted-foreground">
            {t('可以关掉页面，回来后进度会自动恢复。', 'You can close this page; progress resumes when you return.')}
          </p>
        )}
      </CardContent>
      {done && (
        <CardFooter>
          <Button variant="outline" onClick={onReset}>
            {t('再提交一批', 'Submit another batch')}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

function BatchRow({ index, entry, job }: { index: number; entry: BatchEntry; job: Job | undefined }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon
  const expandable = entry.jobId != null && job != null
  return (
    <>
      <tr className={expandable ? 'cursor-pointer' : undefined} onClick={() => expandable && setOpen((v) => !v)}>
        <td className="pr-0 text-muted-foreground">{expandable && <Chevron className="size-4" />}</td>
        <td className="tabular-nums text-muted-foreground">{index + 1}</td>
        <td className="font-medium">
          <div className="max-w-[16rem] truncate">{entry.label}</div>
          {entry.plan && <div className="text-xs text-muted-foreground">{entry.plan}</div>}
        </td>
        <td>
          {entry.jobId == null ? (
            <Badge tone="destructive">{entry.error ?? t('未提交', 'Not submitted')}</Badge>
          ) : !job ? (
            <Badge tone="neutral">{t('任务不存在', 'Job missing')}</Badge>
          ) : (
            <ResultBadge status={job.status} />
          )}
        </td>
        <td className="text-xs text-muted-foreground">
          {job?.status === 'pending'
            ? (job.queue_ahead ?? 0) > 0
              ? t(`前面 ${job.queue_ahead} 个`, `${job.queue_ahead} ahead`)
              : t('即将开始', 'Starting')
            : job
              ? `#${job.id}`
              : '-'}
        </td>
      </tr>
      {open && job && (
        <tr>
          <td colSpan={5} className="bg-surface !py-3">
            <StepList job={job} />
          </td>
        </tr>
      )}
    </>
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
