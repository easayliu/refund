import { api } from './client'
import type { Job } from './admin'

export interface ServiceStatus {
  ready: boolean
}

/** 服务是否就绪（管理员是否已配置可用母号）。 */
export async function getServiceStatus(): Promise<ServiceStatus> {
  const { data } = await api.get<ServiceStatus>('/service/status')
  return data
}

/** 用户提交退款，返回任务 id。 */
export async function submitRefund(user_at: string): Promise<{ job_id: number }> {
  const { data } = await api.post<{ job_id: number }>('/refund/submit', { user_at })
  return data
}

/** 批量提交里每一条的结果，位置与请求数组一一对应。 */
export interface BatchItem {
  index: number
  job_id?: number
  error?: string
}

/** 用户批量提交退款：逐条独立，一条无效不影响其余入队。后端一次最多接 50 条。 */
export async function submitRefundBatch(user_ats: string[]): Promise<BatchItem[]> {
  const { data } = await api.post<BatchItem[]>('/refund/submit-batch', { user_ats })
  return data
}

/** 批量按 id 查任务（批量轮询用）。查不到的 id 会被略过，不在返回里。 */
export async function getJobs(ids: number[]): Promise<Job[]> {
  if (ids.length === 0) return []
  const { data } = await api.get<Job[]>('/refund/jobs', { params: { ids: ids.join(',') } })
  return data
}

/** 按 id 查任务（轮询用）。 */
export async function getJob(id: number): Promise<Job> {
  const { data } = await api.get<Job>(`/refund/jobs/${id}`)
  return data
}
