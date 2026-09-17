import { cn } from '@/lib/utils'

/**
 * 卡片按 Cloudflare 控制台的结构：标题区与内容区之间一条分隔线，可选的页脚放操作按钮
 * （浅灰底、右对齐）。边框 1px 实线、小圆角、不带阴影。
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('overflow-hidden rounded-md border bg-card text-card-foreground', className)}
      {...props}
    />
  )
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 border-b px-5 py-4', className)} {...props} />
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[15px] font-semibold leading-tight', className)} {...props} />
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[13px] leading-relaxed text-muted-foreground', className)} {...props} />
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-end gap-2 border-t bg-surface px-5 py-3', className)}
      {...props}
    />
  )
}
