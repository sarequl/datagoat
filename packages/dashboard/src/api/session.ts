import { apiFetch } from './client';
import type { SessionWhoami } from './types';

export async function whoami(): Promise<SessionWhoami> {
  const response = await apiFetch<SessionWhoami>('/session');
  return response.data;
}

export async function login(password: string): Promise<SessionWhoami> {
  const response = await apiFetch<SessionWhoami>('/session', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  return response.data;
}

export async function logout(): Promise<void> {
  await apiFetch('/session/logout', { method: 'POST' });
}
