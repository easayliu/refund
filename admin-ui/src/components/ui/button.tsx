import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'
type Size = 'sm' | 'md' | 'lg' | 'icon'

/** 按钮对齐 Cloudflare：主按钮实心蓝，次按钮白底蓝字蓝边，普通按钮白底灰边，小圆角。 */
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'border border-primary bg-secondary text-primary hover:bg-accent',
  outline: 'border border-input bg-secondary text-secondary-foreground hover:bg-muted',
  ghost: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
  destructive: 'bg-destructive text-white hover:opacity-90',
  link: 'h-auto px-0 text-link underline-offset-2 hover:underline',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-10 px-5 text-sm',
  icon: 'size-9',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-50',
        sizes[size],
        variants[variant],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
