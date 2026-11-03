import { API_BASE } from '../config';
import type { ApiErrorBody, Pagination } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: number | string;

  constructor(status: number, code: number | string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiResponse<T> {
  data: T;
  pagination?: Pagination;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? response.status,
      error?.message ?? response.statusText,
    );
  }

  return body as ApiResponse<T>;
}
