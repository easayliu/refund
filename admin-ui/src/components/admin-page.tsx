import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, HistoryIcon, KeyRoundIcon, LogOutIcon,
  PlusIcon, ServerIcon, Trash2Icon,
} from 'lucide-react'
import {
  addAdmin, deleteAdmin, listAdmins, listJobs, parseSteps, setAdminDisabled,
  type AdminCred, type Job,
} from '@/api/admin'
import { changePassword, getAuthState } from '@/api/auth'
import { clearPw, setPw } from '@/api/client'
import { extractError, fmtTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { AppHeader } from '@/components/app-header'
import { AppFooter } from '@/components/app-footer'
import { useI18n } from '@/lib/i18n'

type Section = 'admins' | 'jobs' | 'settings'

/**
 * 管理页。布局对齐 Cloudflare 控制台：左侧栏导航（母号 / 任务 / 设置），右侧内容区；
 * 列表用表格而不是卡片堆叠。已通过 App 的登录门控。
 */
export function AdminPage({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useI18n()
  const [section, setSection] = useState<Section>('admins')

  useEffect(() => {
    document.title = t('管理 · refund', 'Admin · refund')
  }, [t])

  const nav: { key: Section; icon: typeof ServerIcon; label: string }[] = [
    { key: 'admins', icon: ServerIcon, label: t('母号', 'Team accounts') },
    { key: 'jobs', icon: HistoryIcon, label: t('任务历史', 'Job history') },
    { key: 'settings', icon: KeyRoundIcon, label: t('设置', 'Settings') },
  ]

  return (
    <div className="app-shell flex min-h-dvh flex-col text-foreground">
      <AppHeader
        subtitle={t('管理控制台', 'Admin console')}
        actions={
          <>
            <a
              href="#/"
              className="inline-flex h-9 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
              {t('用户页', 'User page')}
            </a>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                clearPw()
                onSignOut()
              }}
              title={t('退出登录', 'Sign out')}
              aria-label={t('退出登录', 'Sign out')}
            >
              <LogOutIcon className="size-4" />
            </Button>
          </>
        }
      />

      <div className="page-frame flex-1 py-6 sm:py-8">
        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          {/* 侧栏导航：桌面纵向，手机横向可滚。 */}
          <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:sticky lg:top-20 lg:flex-col lg:self-start lg:px-0">
            {nav.map((n) => (
              <button
                key={n.key}
                type="button"
                className="side-link shrink-0 whitespace-nowrap text-left"
                data-active={section === n.key}
                onClick={() => setSection(n.key)}
              >
                <n.icon className="size-4 shrink-0" />
                {n.label}
              </button>
            ))}
          </nav>

          <main className="min-w-0 space-y-5">
            {section === 'admins' && <AdminsSection />}
            {section === 'jobs' && <JobsSection />}
            {section === 'settings' && <SettingsSection />}
          </main>
        </div>
      </div>

      <AppFooter />
    </div>
  )
}

function PageTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{desc}</p>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-muted-foreground">{children}</p>
}

// ============ 母号 ============

function AdminsSection() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [token, setToken] = useState('')
  const [label, setLabel] = useState('')

  const admins = useQuery({ queryKey: ['admins'], queryFn: listAdmins })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admins'] })
    qc.invalidateQueries({ queryKey: ['service-status'] })
  }

  const add = useMutation({
    mutationFn: () => addAdmin(token.trim(), label.trim() || undefined),
    onSuccess: () => {
      setToken('')
      setLabel('')
      invalidate()
    },
  })
  const toggle = useMutation({
    mutationFn: (a: AdminCred) => setAdminDisabled(a.id, !a.disabled),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => deleteAdmin(id),
    onSuccess: invalidate,
  })

  return (
    <>
      <PageTitle
        title={t('母号', 'Team accounts')}
        desc={t('用户提交时会分派到排队最少的可用母号；同一母号上的任务依次执行。', 'Submissions go to the least-loaded active team account; jobs on one account run in order.')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('已配置母号', 'Configured accounts')}</CardTitle>
        </CardHeader>
        {admins.isLoading ? (
          <Empty>{t('加载中…', 'Loading…')}</Empty>
        ) : !admins.data?.length ? (
          <Empty>{t('暂无母号，在下方添加第一个。', 'No team accounts yet. Add the first one below.')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('备注', 'Label')}</th>
                  <th>{t('邮箱', 'Email')}</th>
                  <th>{t('团队 ID', 'Team ID')}</th>
                  <th>{t('套餐', 'Plan')}</th>
                  <th>{t('状态', 'Status')}</th>
                  <th className="text-right">{t('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {admins.data.map((a) => (
                  <tr key={a.id}>
                    <td className="font-medium">{a.label}</td>
                    <td className="text-muted-foreground">{a.email ?? '-'}</td>
                    <td>
                      <code className="font-mono text-xs text-muted-foreground">{a.account_id}</code>
                    </td>
                    <td>{a.plan_type ? <Badge tone="info" dot={false}>{a.plan_type}</Badge> : '-'}</td>
                    <td>
                      {a.disabled ? (
                        <Badge tone="neutral">{t('已停用', 'Disabled')}</Badge>
                      ) : (
                        <Badge tone="success">{t('启用中', 'Active')}</Badge>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => toggle.mutate(a)} disabled={toggle.isPending}>
                          {a.disabled ? t('启用', 'Enable') : t('停用', 'Disable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (window.confirm(t(`删除母号「${a.label}」？`, `Delete team account "${a.label}"?`))) remove.mutate(a.id)
                          }}
                          aria-label={t('删除', 'Delete')}
                          className="text-destructive-foreground hover:text-destructive-foreground"
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('添加母号', 'Add team account')}</CardTitle>
          <CardDescription>
            {t(
              '粘贴母号（团队管理员）的 access_token，也可直接粘贴 chatgpt.com/api/auth/session 返回的整段 JSON。同一团队重复添加会更新原有记录。',
              'Paste the team admin access_token, or the whole JSON from chatgpt.com/api/auth/session. Re-adding the same team updates the existing record.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="admin-label" className="text-[13px] font-semibold">
              {t('备注名', 'Label')}{' '}
              <span className="font-normal text-muted-foreground">{t('（可选）', '(optional)')}</span>
            </label>
            <Input
              id="admin-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('例如：团队 A', 'e.g. Team A')}
              className="max-w-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="admin-token" className="text-[13px] font-semibold">
              access_token
            </label>
            <Textarea
              id="admin-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('eyJhbGciOi... 或整段 session JSON', 'eyJhbGciOi... or the whole session JSON')}
              spellCheck={false}
              className="min-h-28 break-all text-xs leading-relaxed"
            />
          </div>
          {add.isError && <p className="text-[13px] text-destructive-foreground">{extractError(add.error)}</p>}
        </CardContent>
        <CardFooter>
          <Button disabled={!token.trim() || add.isPending} onClick={() => add.mutate()}>
            <PlusIcon className="size-4" />
            {add.isPending ? t('添加中…', 'Adding…') : t('添加母号', 'Add')}
          </Button>
        </CardFooter>
      </Card>
    </>
  )
}

// ============ 任务 ============

function JobsSection() {
  const { t } = useI18n()
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: listJobs, refetchInterval: 5000 })

  const counts = (jobs.data ?? []).reduce(
    (acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  return (
    <>
      <PageTitle title={t('任务历史', 'Job history')} desc={t('最近 200 条退款流程记录，每 5 秒自动刷新。', 'Latest 200 runs, refreshed every 5 seconds.')} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('排队中', 'Queued')} value={counts.pending ?? 0} />
        <Stat label={t('执行中', 'Running')} value={counts.running ?? 0} />
        <Stat label={t('成功', 'Succeeded')} value={counts.success ?? 0} />
        <Stat label={t('失败', 'Failed')} value={counts.failed ?? 0} />
      </div>

      <Card>
        {jobs.isLoading ? (
          <Empty>{t('加载中…', 'Loading…')}</Empty>
        ) : !jobs.data?.length ? (
          <Empty>{t('暂无任务。', 'No jobs yet.')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-8" />
                  <th>ID</th>
                  <th>{t('用户', 'User')}</th>
                  <th>{t('状态', 'Status')}</th>
                  <th>{t('母号', 'Team account')}</th>
                  <th>{t('提交时间', 'Submitted')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </Card>
  )
}

function StatusBadge({ status }: { status: Job['status'] }) {
  const { t } = useI18n()
  if (status === 'success') return <Badge tone="success">{t('成功', 'Success')}</Badge>
  if (status === 'failed') return <Badge tone="destructive">{t('失败', 'Failed')}</Badge>
  if (status === 'running') return <Badge tone="info">{t('执行中', 'Running')}</Badge>
  return <Badge tone="warning">{t('排队中', 'Queued')}</Badge>
}

function JobRow({ job }: { job: Job }) {
  const [open, setOpen] = useState(false)
  const steps = parseSteps(job)
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon
  return (
    <>
      <tr className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <td className="pr-0 text-muted-foreground">
          <Chevron className="size-4" />
        </td>
        <td className="tabular-nums text-muted-foreground">#{job.id}</td>
        <td className="font-medium">
          <div className="max-w-[16rem] truncate">{job.user_email ?? job.user_id ?? '-'}</div>
          {job.user_plan && <div className="text-xs text-muted-foreground">{job.user_plan}</div>}
        </td>
        <td>
          <StatusBadge status={job.status} />
        </td>
        <td className="text-muted-foreground">{job.admin_email ?? job.admin_id ?? '-'}</td>
        <td className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtTime(job.created_at)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-surface !py-3">
            {steps.length === 0 ? (
              <span className="text-xs text-muted-foreground">-</span>
            ) : (
              <ol className="space-y-1.5">
                {steps.map((s, i) => (
                  <li key={i} className="grid grid-cols-[6rem_1fr] gap-3 text-xs sm:grid-cols-[8rem_1fr]">
                    <span className={'font-semibold ' + (s.ok ? 'text-success-foreground' : 'text-destructive-foreground')}>
                      {s.ok ? '✓' : '✕'} {s.step}
                    </span>
                    <span className="break-all font-mono text-muted-foreground">{s.detail}</span>
                  </li>
                ))}
              </ol>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ============ 设置 ============

function SettingsSection() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const auth = useQuery({ queryKey: ['auth-state'], queryFn: getAuthState })
  const [pw, setPwInput] = useState('')
  const [ok, setOk] = useState(false)

  const change = useMutation({
    mutationFn: () => changePassword(pw.trim()),
    onSuccess: () => {
      // 改完把本地存的密码同步成新的，后续请求才带得对。
      setPw(pw.trim())
      setPwInput('')
      setOk(true)
      qc.invalidateQueries({ queryKey: ['auth-state'] })
    },
  })

  const envManaged = auth.data?.env_managed === true

  return (
    <>
      <PageTitle title={t('设置', 'Settings')} desc={t('管理控制台的访问密码。', 'Access password for this console.')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('修改管理密码', 'Change admin password')}</CardTitle>
          <CardDescription>
            {envManaged
              ? t('管理密码由环境变量 REFUND_ADMIN_PASSWORD 接管，网页不可修改。', 'The password is set by the REFUND_ADMIN_PASSWORD environment variable and cannot be changed here.')
              : t('至少 4 位。修改后当前浏览器会自动使用新密码。', 'At least 4 characters. This browser switches to the new password automatically.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="new-pw" className="text-[13px] font-semibold">
              {t('新密码', 'New password')}
            </label>
            <Input
              id="new-pw"
              type="password"
              value={pw}
              disabled={envManaged}
              autoComplete="new-password"
              onChange={(e) => {
                setPwInput(e.target.value)
                setOk(false)
              }}
              className="max-w-sm"
            />
          </div>
          {change.isError && <p className="text-[13px] text-destructive-foreground">{extractError(change.error)}</p>}
          {ok && <p className="text-[13px] text-success-foreground">{t('密码已更新。', 'Password updated.')}</p>}
        </CardContent>
        <CardFooter>
          <Button disabled={envManaged || pw.trim().length < 4 || change.isPending} onClick={() => change.mutate()}>
            {change.isPending ? t('保存中…', 'Saving…') : t('保存', 'Save')}
          </Button>
        </CardFooter>
      </Card>
    </>
  )
}
