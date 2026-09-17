import { CheckCircle2Icon, CircleDashedIcon, Loader2Icon, XCircleIcon } from 'lucide-react'
import type { Job, StepResult } from '@/api/admin'
import { parseSteps } from '@/api/admin'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** 四步流程的展示元信息（机器标识 → 文案）。 */
const STEP_META: Record<string, { zh: string; en: string; order: number }> = {
  invite: { zh: '邀请加入团队', en: 'Invite to team', order: 1 },
  accept: { zh: '接受邀请', en: 'Accept invite', order: 2 },
  check: { zh: '校验团队成员', en: 'Verify membership', order: 2.5 },
  transfer: { zh: '去除个人空间', en: 'Remove personal space', order: 3 },
  kick: { zh: '移出团队', en: 'Kick from team', order: 4 },
  interrupted: { zh: '任务中断', en: 'Interrupted', order: 9 },
}

export function StepList({ job }: { job: Job }) {
  const { t, language } = useI18n()
  const steps = parseSteps(job)

  // 未开始（pending）时展示四步的占位骨架，让用户看到全流程。
  if (job.status === 'pending' || (steps.length === 0 && job.status !== 'failed')) {
    return (
      <ol className="space-y-2">
        {(['invite', 'accept', 'transfer', 'kick'] as const).map((key) => (
          <li key={key} className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <CircleDashedIcon className="size-4 shrink-0" />
            <span>{language === 'en' ? STEP_META[key].en : STEP_META[key].zh}</span>
          </li>
        ))}
      </ol>
    )
  }

  const running = job.status === 'running'
  return (
    <ol className="space-y-2.5">
      {steps.map((s: StepResult, i) => {
        const meta = STEP_META[s.step]
        const label = meta ? (language === 'en' ? meta.en : meta.zh) : s.step
        const last = i === steps.length - 1
        const inProgress = running && last
        return (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {inProgress ? (
              <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : s.ok ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className={cn('font-medium', !s.ok && 'text-destructive-foreground')}>{label}</div>
              <div className="mt-1 break-all rounded-sm bg-surface px-2 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{s.detail}</div>
            </div>
          </li>
        )
      })}
      {running && (
        <li className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 shrink-0 animate-spin" />
          <span>{t('执行中，请稍候…', 'Running, please wait…')}</span>
        </li>
      )}
    </ol>
  )
}
