import { api } from './client'

/** 母号凭证（后端不回吐 access_token）。 */
export interface AdminCred {
  id: number
  label: string
  email: string | null
  account_id: string
  plan_type: string | null
  disabled: boolean
  created_at: number
  updated_at: number
}

export async function listAdmins(): Promise<AdminCred[]> {
  const { data } = await api.get<AdminCred[]>('/admin/admins')
  return data
}

export async function addAdmin(access_token: string, label?: string): Promise<AdminCred> {
  const { data } = await api.post<AdminCred>('/admin/admins', { access_token, label })
  return data
}

export async function setAdminDisabled(id: number, disabled: boolean): Promise<void> {
  await api.post(`/admin/admins/${id}/disabled`, { disabled })
}

export async function deleteAdmin(id: number): Promise<void> {
  await api.delete(`/admin/admins/${id}`)
}

export async function listJobs(): Promise<Job[]> {
  const { data } = await api.get<Job[]>('/admin/jobs')
  return data
}

/** 一步的结果，对应后端 flow::StepResult。 */
export interface StepResult {
  step: string
  ok: boolean
  status: number | null
  detail: string
}

/** 退款任务。 */
export interface Job {
  id: number
  user_email: string | null
  user_id: string | null
  user_plan: string | null
  admin_id: number | null
  admin_email: string | null
  status: 'pending' | 'running' | 'success' | 'failed'
  steps_json: string
  created_at: number
  updated_at: number
  /** 同母号队列里排在前面的未完成任务数（仅 `/refund/jobs/:id` 返回）。 */
  queue_ahead?: number
}

/** 解析任务的步骤日志。 */
export function parseSteps(job: Job): StepResult[] {
  try {
    return JSON.parse(job.steps_json) as StepResult[]
  } catch {
    return []
  }
}
