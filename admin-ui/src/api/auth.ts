import { api } from './client'

export interface AuthState {
  configured: boolean
  env_managed: boolean
}

export async function getAuthState(): Promise<AuthState> {
  const { data } = await api.get<AuthState>('/auth/state')
  return data
}

export async function login(password: string): Promise<void> {
  await api.post('/auth/login', { password })
}

export async function setup(password: string): Promise<void> {
  await api.post('/auth/setup', { password })
}

export async function changePassword(password: string): Promise<void> {
  await api.post('/admin/password', { password })
}
