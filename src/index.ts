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

type Stats = {
	osFamily?: Record<string, number>;
	os?: Record<string, number>;
	language?: Record<string, number>;
	version?: Record<string, number>;
};

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
	await updatePopularityContest(request, env);
	const url = new URL(request.url);
	if (url.pathname === '/') {
		return index(url);
	} else if (url.pathname.startsWith('/version')) {
		return await version(request, env);
	} else if (url.pathname.startsWith('/stats')) {
		return await stats(env);
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
		`<p>Popularity contest: <a href="/stats">/stats</a> (JSON)</p>`,
	];
	return new Response(htmlRows.join('\n'), {
		status: 200,
		headers: { 'Content-Type': 'text/html' },
	});
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

function getOsFamily(os: string | null): string | null {
	if (!os) return null;
	if (os.includes('Windows')) return 'Windows';
	if (os.includes('macOS')) return 'macOS';
	if (['Linux', 'Flatpak'].some((term) => os.includes(term))) return 'Linux';
	if (os.includes('BSD')) return 'BSD';
	return 'Other';
}

async function updatePopularityContest(request: Request, env: Env): Promise<void> {
	const userAgent = request.headers.get('user-agent') ?? null;
	const appLanguage = request.headers.get('X-Deskflow-Language') ?? null;
	const appVersion = request.headers.get('X-Deskflow-Version') ?? null;
	const os = userAgent ? /on (.+)/.exec(userAgent)?.[1] ?? null : null;
	const osFamily = getOsFamily(os);
	console.debug('User-Agent:', userAgent);
	console.debug('App info:', `OS=${os} (${osFamily}), Language=${appLanguage}, Version=${appVersion}`);

	if (!appLanguage && !appVersion && !os) {
		console.debug('No stats info provided, skipping popularity contest update');
		return;
	}

	const date = new Date();
	const monthKey = date.toISOString().substring(0, 7); // e.g. "2024-04"

	const entry = await env.APP_STATS.get(monthKey);
	const stats: Stats = entry ? JSON.parse(entry) : {};

	if (os) {
		if (!stats.os) stats.os = {};
		stats.os[os] = (stats.os[os] ?? 0) + 1;
	}

	if (osFamily) {
		if (!stats.osFamily) stats.osFamily = {};
		stats.osFamily[osFamily] = (stats.osFamily[osFamily] ?? 0) + 1;
	}

	if (appLanguage) {
		if (!stats.language) stats.language = {};
		stats.language[appLanguage] = (stats.language[appLanguage] ?? 0) + 1;
	}

	if (appVersion) {
		if (!stats.version) stats.version = {};
		stats.version[appVersion] = (stats.version[appVersion] ?? 0) + 1;
	}

	console.debug(`Updating stats for ${monthKey}`);
	await env.APP_STATS.put(monthKey, JSON.stringify(stats));
}

function sortByValueDesc<T extends Record<string, number>>(obj: T): T {
	return Object.fromEntries(Object.entries(obj).sort(([, a], [, b]) => b - a)) as T;
}

async function getSortedStats(env: Env, entryKey: string): Promise<Stats> {
	const entry = await env.APP_STATS.get(entryKey);
	const stats = entry ? JSON.parse(entry) : {};
	return {
		os: stats.os ? sortByValueDesc(stats.os) : {},
		osFamily: stats.osFamily ? sortByValueDesc(stats.osFamily) : {},
		language: stats.language ? sortByValueDesc(stats.language) : {},
		version: stats.version ? sortByValueDesc(stats.version) : {},
	};
}

async function stats(env: Env): Promise<Response> {
	const date = new Date();
	const lastMonthDate = new Date(date.getFullYear(), date.getMonth() - 1, 1);

	const thisMonthKey = date.toISOString().substring(0, 7); // e.g. "2024-04"
	const lastMonthKey = lastMonthDate.toISOString().substring(0, 7); // e.g. "2024-03"

	console.debug(`Fetching stats for ${thisMonthKey} and ${lastMonthKey}`);

	const thisMonth = await getSortedStats(env, thisMonthKey);
	const lastMonth = await getSortedStats(env, lastMonthKey);

	const result = { thisMonth: { date: thisMonthKey, ...thisMonth }, lastMonth: { date: lastMonthKey, ...lastMonth } };
	return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
