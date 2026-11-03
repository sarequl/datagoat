// Typed mock data for the frozen `/api/v1` contract. Values are examples, not
// real analytics. Fixtures are added per dashboard milestone; the mock router
// returns 404 for endpoints that have no fixture yet.
export const MOCK_PASSWORD = process.env.VITE_MOCK_PASSWORD ?? 'password';

export const MOCK_SESSION_TOKEN = 'mock-dg-session-token';
