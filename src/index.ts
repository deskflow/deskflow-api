// SPDX-Copyright-Text: 2024-2025 Symless Ltd.
// SPDX-License-Identifier: GPL-2.0-only

import { Octokit } from '@octokit/rest';

// Important: Cache lifetime must not be too low or we'll hit the KV put rate limit.
// We're using a GitHub token since the public rate limit is easily hit on shared egress IPs;
// Workers from other orgs could also be hitting the GitHub API from the same IP addresses,
// so we can't rely on the public rate limit of 60 requests per hour not being exceeded.
// The token gives us a higher rate limit of 5000 requests per hour, but there is no need for
// us to update the cache often, and it takes around 2 seconds for GitHub to respond.
const cacheAgeSeconds = 60 * 5; // 5 minutes

// Too low and it returns only the 'continuous' release.
const releasesPerPage = 20;

const repoUrl = 'https://github.com/deskflow/deskflow-api';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			console.error('Server error:', error);

			const requestId = request.headers.get('cf-ray') ?? 'unknown';
			console.error(`Request ID: ${requestId}`);
			const message = `Server error. Please report this issue with the request ID ${requestId} at ${repoUrl}/issues`;
			return new Response(message, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/') {
		return index(url);
	} else if (url.pathname.startsWith('/version')) {
		return await version(request, env);
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

async function getLatestRelease(octokit: Octokit) {
	let page = 1;
	const perPage = 100; // 100 is max (30 is default)
	const maxPages = 10; // Prevent infinite loop
	while (page <= maxPages) {
		const { data: releases } = await octokit.repos.listReleases({
			owner: 'deskflow',
			repo: 'deskflow',
			per_page: perPage,
			page,
		});

		// Some pages have hidden (deleted) releases, so having pages with no releases is not a
		// reliable indicator that we've reached the end.
		// This is why we have to manually paginate rather than using `octokit.paginate` (which
		// stops when an empty page is reached).
		if (releases.length === 0) continue;

		const stable = releases.find((r) => !r.prerelease);
		if (stable) {
			console.log(`Found stable release ${stable.tag_name} on page ${page}`);
			return stable;
		}
		page++;
	}
	return null;
}

async function version(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	const fake = url.searchParams.get('fake');
	if (fake) {
		return new Response(fake);
	}

	// Previously we used the Worker Cache API, but this was not a valid approach for avoiding
	// rate limits, since the cache is per-POP (Cloudflare point of presence) of which there could
	// be hundreds worldwide. So we switched to using Workers KV, which is global.
	const { value: cachedVersion, metadata } = await env.APP_VERSION.getWithMetadata('latest');
	if (cachedVersion) {
		const { fetchedAt } = metadata as { fetchedAt: string };
		if (!fetchedAt) throw new Error('Metadata missing field: fetchedAt');

		const fetchedAtDate = new Date(fetchedAt);
		const ageSeconds = (Date.now() - fetchedAtDate.getTime()) / 1000;
		const isValid = ageSeconds < cacheAgeSeconds;
		console.log(`Version KV found, value=${cachedVersion}, age=${Math.round(ageSeconds)}s (${isValid ? 'valid' : 'expired'})`);
		if (isValid) {
			return new Response(cachedVersion);
		}
	}

	if (!env.GITHUB_TOKEN) {
		throw new Error('Secret not found: GITHUB_TOKEN');
	}

	console.log('Cache miss for version, fetching from GitHub');
	const octokit = new Octokit({
		auth: env.GITHUB_TOKEN,
		userAgent: 'Deskflow API',
	});
	const latestRelease = await getLatestRelease(octokit);
	if (!latestRelease) {
		throw new Error('No stable releases found');
	}

	// Backward compatibility: Strip any 'v' prefix, since the GUI doesn't expect one.
	const versionRaw = latestRelease.tag_name;
	const version = versionRaw.replace(/^v/, '');

	console.log(`Latest version is ${version}, storing in KV`);
	await env.APP_VERSION.put('latest', version, {
		metadata: { fetchedAt: new Date().toISOString() },
	});

	return new Response(version);
}
