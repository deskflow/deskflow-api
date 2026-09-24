import { createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('worker', () => {
	it('serves the index page', async () => {
		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Deskflow API');
	});

	it('returns 404 for unknown paths', async () => {
		const response = await SELF.fetch('https://example.com/stats');

		expect(response.status).toBe(404);
	});

	it('returns the fake version when asked', async () => {
		const response = await SELF.fetch('https://example.com/version?fake=9.9.9');

		expect(await response.text()).toBe('9.9.9');
	});

	it('returns the latest GitHub release without the v prefix', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ tag_name: 'v1.26.0' }));

		const response = await SELF.fetch('https://example.com/version');

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('1.26.0');
		const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer test-token');
	});

	it('calls GitHub anonymously when no token is set', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ tag_name: 'v1.26.0' }));
		const ctx = createExecutionContext();

		const response = await worker.fetch(new Request('https://no-token.example.com/version'), {} as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(await response.text()).toBe('1.26.0');
		const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it('returns 500 with a request ID when GitHub fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Bad credentials', { status: 401 }));

		const response = await SELF.fetch('https://another.example.com/version', { headers: { 'cf-ray': 'abc123' } });

		expect(response.status).toBe(500);
		expect(await response.text()).toContain('abc123');
	});
});
