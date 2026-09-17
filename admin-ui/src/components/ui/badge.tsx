import { cn } from '@/lib/utils'

type Tone = 'neutral' | 'success' | 'warning' | 'destructive' | 'info'

/** 状态标签：Cloudflare 风格的小圆角浅底色块，左侧带一个实心圆点。 */
const tones: Record<Tone, { box: string; dot: string }> = {
  neutral: { box: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  success: { box: 'bg-success/10 text-success-foreground', dot: 'bg-success' },
  warning: { box: 'bg-warning/12 text-warning-foreground', dot: 'bg-warning' },
  destructive: { box: 'bg-destructive/10 text-destructive-foreground', dot: 'bg-destructive' },
  info: { box: 'bg-accent text-accent-foreground', dot: 'bg-primary' },
}

export function Badge({
  tone = 'neutral',
  dot = true,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone].box,
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('size-1.5 shrink-0 rounded-full', tones[tone].dot)} />}
      {children}
    </span>
  )
}
