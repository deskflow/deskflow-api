// SPDX-Copyright-Text: 2024 Symless Ltd.
// SPDX-License-Identifier: GPL-2.0-only

import { Octokit } from '@octokit/rest';

// With no API token, we can only make 60 requests per hour, but if we cache the response,
// we can limit our requests to once every 2 minutes (which is 30 per hour).
// We could limit this further to like 1 per hour, but this might confuse developers not aware
// of the cache ("Why is the API version response not updating?")
const cacheAgeSeconds = 60 * 2; // 2 mins (30 requests per hour)

// Too low and it returns only the 'continuous' release.
const releasesPerPage = 10;

const repoUrl = 'https://github.com/deskflow/deskflow-api';

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
	logClient(request);
	const url = new URL(request.url);
	if (url.pathname.startsWith('/version')) {
		return await version(request, env);
	} else if (url.pathname === '/') {
		if (url.searchParams.get('testError') !== null) {
			throw new Error('Test error');
		}
		return new Response(`Deskflow API. Source code: ${repoUrl}`, { status: 200 });
	} else {
		return new Response('Not found', { status: 404 });
	}
}

function logClient(request: Request) {
	const userAgent = request.headers.get('user-agent') ?? 'unknown';
	const appLanguage = request.headers.get('X-Deskflow-Language') ?? 'unknown';
	const appVersion = request.headers.get('X-Deskflow-Version') ?? 'unknown';
	console.debug('User-Agent:', userAgent);
	console.debug('App info:', `Language=${appLanguage}, Version=${appVersion}`);
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
	// We could use a GitHub token to increase the rate limit, but that would be a secret
	// to manage, and we don't really need the extra limit since we can simply cache in KV.
	// It's also possible that the rate limit for the token could be reached if our user count increases.
	const { value: cachedVersion, metadata } = await env.APP_VERSION.getWithMetadata('latest');
	if (cachedVersion) {
		const { fetchedAt } = metadata as { fetchedAt: string };
		if (!fetchedAt) throw new Error('Metadata missing field: fetchedAt');

		const fetchedAtDate = new Date(fetchedAt);
		const ageSeconds = (Date.now() - fetchedAtDate.getTime()) / 1000;
		console.debug(`KV version ${cachedVersion} found, age is ${Math.round(ageSeconds)} seconds`);
		if (ageSeconds < cacheAgeSeconds) {
			console.debug('Cache valid, returning cached version');
			return new Response(cachedVersion);
		}
	}

	console.debug('Cache miss for version, fetching from GitHub');
	const octokit = new Octokit();
	const { data: releases } = await octokit.repos.listReleases({
		owner: 'deskflow',
		repo: 'deskflow',
		per_page: releasesPerPage,
	});

	if (releases.length === 0) {
		return new Response('No releases found', { status: 404 });
	}

	const filteredReleases = releases.filter((release) => release.tag_name !== 'continuous');
	console.debug(`Found ${filteredReleases.length} releases, excluding 'continuous'`);
	if (filteredReleases.length == 0) {
		return new Response('No releases found (except continuous)', { status: 404 });
	}

	// Backward compatibility: Strip any 'v' prefix, since the GUI doesn't expect one.
	const versionRaw = filteredReleases[0].tag_name;
	const version = versionRaw.replace(/^v/, '');

	console.debug(`Latest version is ${version}, storing in KV`);
	await env.APP_VERSION.put('latest', version, {
		metadata: { fetchedAt: new Date().toISOString() },
	});

	return new Response(version);
}
