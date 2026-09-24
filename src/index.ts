// SPDX-Copyright-Text: 2024-2025 Symless Ltd.
// SPDX-License-Identifier: GPL-2.0-only

// The Cache API is per data center, so each one asks GitHub at most once per cache lifetime.
// Keep this well above (data centers / GitHub's 5000 per hour token limit).
const cacheAgeSeconds = 60 * 10;

const repoUrl = 'https://github.com/deskflow/deskflow-api';
const latestReleaseUrl = 'https://api.github.com/repos/deskflow/deskflow/releases/latest';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			console.error('Server error:', error);

			const requestId = request.headers.get('cf-ray') ?? 'unknown';
			console.error(`Request ID: ${requestId}`);
			const message = `Server error. Please report this issue with the request ID ${requestId} at ${repoUrl}/issues`;
			return new Response(message, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/') {
		return index(url);
	} else if (url.pathname.startsWith('/version')) {
		return await version(url, env, ctx);
	} else {
		return new Response('Not found', { status: 404 });
	}
}

function index(url: URL) {
	if (url.searchParams.get('testError') !== null) {
		throw new Error('Test error');
	}
	const htmlRows = [
		`<style>`,
		`  body { font-family: sans-serif; }`,
		`  @media (prefers-color-scheme: dark) {`,
		`    body { background: #111; color: #eee; }`,
		`    a { color: #4ea1f3; }`,
		`  }`,
		`</style>`,
		`<h1>Deskflow API</h1>`,
		`<p>Source code: <a href="${repoUrl}">${repoUrl}</a></p>`,
	];
	return new Response(htmlRows.join('\n'), {
		status: 200,
		headers: { 'Content-Type': 'text/html' },
	});
}

async function version(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const fake = url.searchParams.get('fake');
	if (fake) {
		return new Response(fake);
	}

	const cacheKey = new Request(`${url.origin}/version`);
	const cached = await caches.default.match(cacheKey);
	if (cached) {
		return cached;
	}

	const version = await fetchLatestVersion(env);
	console.log(`Latest version from GitHub: ${version}`);

	const response = new Response(version, {
		headers: { 'Cache-Control': `public, max-age=${cacheAgeSeconds}` },
	});
	ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
	return response;
}

async function fetchLatestVersion(env: Env): Promise<string> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'Deskflow API',
	};

	// The anonymous rate limit is shared with everyone on the same egress IP, so prefer a token.
	if (env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	} else {
		console.warn('No GitHub token set, using the anonymous rate limit');
	}

	const response = await fetch(latestReleaseUrl, { headers });
	if (!response.ok) {
		throw new Error(`GitHub responded with ${response.status}: ${await response.text()}`);
	}

	const release = (await response.json()) as { tag_name: string };

	// The GUI doesn't expect a 'v' prefix.
	return release.tag_name.replace(/^v/, '');
}
