// SPDX-Copyright-Text: 2024 Symless Ltd.
// SPDX-License-Identifier: GPL-2.0-only

import { Octokit } from '@octokit/rest';
import { DurableObject } from 'cloudflare:workers';

// With no API token, we can only make 60 requests per hour, but if we cache the response,
// we can limit our requests to once every 2 minutes (which is 30 per hour).
// We could limit this further to like 1 per hour, but this might confuse developers not aware
// of the cache ("Why is the API version response not updating?")
const cacheAgeSeconds = 60 * 2; // 2 mins (30 requests per hour)

// Too low and it returns only the 'continuous' release.
const releasesPerPage = 10;

const repoUrl = 'https://github.com/deskflow/deskflow-api';

type Stats = {
	os?: Record<string, number>;
	osFamily?: Record<string, number>;
	language?: Record<string, number>;
	version?: Record<string, number>;
};

type Votes = {
	isoDateText: string;
	userAgent: string;
};

export class SlowKV extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async set(key: string, data: string) {
		await this.ctx.storage.put(key, data);
	}

	async getString(key: string): Promise<string | undefined> {
		return this.ctx.storage.get<string>(key);
	}

	async getStats(key: string): Promise<Stats> {
		const stats = await this.ctx.storage.get<string>(key);
		return stats ? JSON.parse(stats) : {};
	}
}

export class VotesByIP extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async recordVote(votes: Votes[], ip: string, userAgent: string) {
		const data = [...votes, { isoDateText: new Date().toISOString(), userAgent }];
		await this.ctx.storage.put(ip, JSON.stringify(data));
	}

	async findVotes(ip: string): Promise<Votes[]> {
		const record = await this.ctx.storage.get<string>(ip);
		if (record == null) {
			console.debug(`No votes for IP ${ip}`);
			return [];
		}

		const data = JSON.parse(record) as Votes[];
		console.debug(`Found votes for IP ${ip}:`, data);
		return data;
	}
}

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
	try {
		// Void instead of await for better performance; side-effects are not relevant to the response.
		void updatePopularityContest(request, env);
	} catch (error) {
		// Not very important if this fails, so just log a warning.
		console.warn('Error updating popularity contest:', error);
	}

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
		const isValid = ageSeconds < cacheAgeSeconds;
		console.debug(`Version KV found, value=${cachedVersion}, age=${Math.round(ageSeconds)}s (${isValid ? 'valid' : 'expired'})`);
		if (isValid) {
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
	const lower = os?.toLowerCase() ?? null;
	if (!lower) return null;
	if (lower.includes('windows')) return 'Windows';
	if (lower.includes('macos')) return 'macOS';
	if (['linux', 'flatpak'].some((term) => lower.includes(term))) return 'Linux';
	if (lower.includes('bsd')) return 'BSD';
	return 'Other';
}

function parseUserAgent(userAgent: string, headers: Headers) {
	if (!userAgent.includes('Deskflow')) {
		console.debug('User-Agent does not contain Deskflow, skipping parsing');
		return null;
	}

	// If we're using RFC 9110 User-Agent, use that instead of custom headers (which are obsolete).
	const rfc9110 = /Deskflow\/(.+) \((.+)\)/;
	if (rfc9110.test(userAgent)) {
		console.debug('Parsing RFC 9110 User-Agent');
		const parts = rfc9110.exec(userAgent);
		if (!parts) {
			throw new Error('Invalid RFC 9110 User-Agent format');
		}

		// Based on app code that generates the User-Agent:
		//   const static auto userAgent = QString("%1/%2 (%3; %4; %5; %6)")
		//     .arg(kAppName, kVersion, os, osFamily, arch, language);
		const metadata = parts[2].split(';').map((part) => part.trim());
		const os = metadata[0] ?? null;
		const osFamily = getOsFamily(metadata[1] ?? null);
		const appVersion = metadata[2] ?? null;
		const appLanguage = metadata[3] ?? null;
		return { os, osFamily, appLanguage, appVersion };
	} else {
		console.debug('Parsing legacy User-Agent and custom headers');

		const appLanguage = headers.get('X-Deskflow-Language') ?? null;
		const appVersion = headers.get('X-Deskflow-Version') ?? null;

		const os = userAgent ? /Deskflow .+ on (.+)/.exec(userAgent)?.[1] ?? null : null;
		const osFamily = getOsFamily(os);

		return { os, osFamily, appLanguage, appVersion };
	}
}

// Count a vote as being from the same IP, user agent, and day.
// Allow multiple votes from the same IP, since a user will have multiple computers.
function hasVoted(data: Votes[], userAgent: string): boolean {
	const now = new Date().toISOString().slice(0, 10);
	const result = data.some((vote) => {
		return vote.userAgent === userAgent && vote.isoDateText.slice(0, 10) === now;
	});

	console.debug(`Found ${data.length} votes matching user agent and date`);
	return result;
}

async function updatePopularityContest(request: Request, env: Env): Promise<void> {
	const userAgent = request.headers.get('user-agent') ?? null;
	if (!userAgent) throw new Error('User-Agent header is missing');

	console.debug('User-Agent:', userAgent);
	const info = parseUserAgent(userAgent, request.headers);

	if (!info) {
		console.debug('Unrecognized user agent, skipping popularity contest update');
		return;
	}

	const { os, osFamily, appLanguage, appVersion } = info;
	console.debug('App info:', `OS=${os} (${osFamily}), Language=${appLanguage}, Version=${appVersion}`);

	if (!os && !osFamily && !appLanguage && !appVersion) {
		console.debug('No user agent info provided, skipping popularity contest update');
		return;
	}

	console.debug(`Checking for existing vote`);
	const votesByIP = getVotesByIP(env);
	const ip = request.headers.get('cf-connecting-ip');
	if (!ip) throw new Error('Header missing: cf-connecting-ip');

	const votes = await votesByIP.findVotes(ip);
	if (hasVoted(votes, userAgent)) {
		console.debug(`IP ${ip} has already voted recently, skipping popularity contest update`);
		return;
	}

	const date = new Date();
	const monthKey = date.toISOString().substring(0, 7); // e.g. "2024-04"

	console.debug(`Fetching existing stats for ${monthKey}`);
	const slowKV = getSlowKV(env);
	const stats = await slowKV.getStats(monthKey);

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

	console.debug(`Updating popularity contest for ${monthKey}`);
	await slowKV.set(monthKey, JSON.stringify(stats));

	console.debug(`Recording vote for IP ${ip}`);
	await votesByIP.recordVote(votes, ip, userAgent);
}

// Effectively a slower version of the Worker KV, but has no read/write limits.
function getSlowKV(env: Env) {
	const objectId = env.SlowKV.idFromName('default');
	return env.SlowKV.get(objectId);
}

function getVotesByIP(env: Env) {
	const objectId = env.VotesByIP.idFromName('default');
	return env.VotesByIP.get(objectId);
}

function sortByValueDesc<T extends Record<string, number>>(obj: T): T {
	return Object.fromEntries(Object.entries(obj).sort(([, a], [, b]) => b - a)) as T;
}

async function getSortedStats(env: Env, entryKey: string): Promise<Stats> {
	const slowKV = getSlowKV(env);
	const stats = await slowKV.getStats(entryKey);
	return {
		osFamily: stats.osFamily ? sortByValueDesc(stats.osFamily) : {},
		os: stats.os ? sortByValueDesc(stats.os) : {},
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
