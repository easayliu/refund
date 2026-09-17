import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

const base =
  'w-full rounded-sm border border-input bg-card text-sm text-foreground transition-colors ' +
  'placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/25'

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(base, 'flex h-9 px-3 py-1', className)} {...props} />
  ),
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(base, 'flex min-h-24 px-3 py-2 font-mono', className)} {...props} />
  ),
)
Textarea.displayName = 'Textarea'
