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

/** 按 id 查任务（轮询用）。 */
export async function getJob(id: number): Promise<Job> {
  const { data } = await api.get<Job>(`/refund/jobs/${id}`)
  return data
}
