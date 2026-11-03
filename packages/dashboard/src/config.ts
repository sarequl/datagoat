// Same-origin API base. The Worker serves the dashboard and the API from one
// origin, so the default is a relative path and no CORS is needed.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api/v1';
