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

export default {
	async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/version')) {
			return await version(request, url);
		} else {
			return new Response('Not found', { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;

async function version(request: Request, url: URL): Promise<Response> {
	const fake = url.searchParams.get('fake');
	if (fake) {
		return new Response(fake);
	}

	const cache = caches.default;
	const cachedResponse = await cache.match(request);
	if (cachedResponse) {
		console.debug('Cache hit for version');
		return cachedResponse;
	}

	const octokit = new Octokit();
	const { data: releases } = await octokit.repos.listReleases({
		owner: 'deskflow',
		repo: 'deskflow',
		per_page: releasesPerPage,
	});

	if (releases.length === 0) {
		return new Response('No releases found', { status: 404 });
	}

	console.debug(
		'Fetched releases:',
		releases.map((release) => release.tag_name)
	);

	const filteredReleases = releases.filter((release) => release.tag_name !== 'continuous');
	console.debug(`Found ${filteredReleases.length} releases, excluding 'continuous'`);
	if (filteredReleases.length == 0) {
		return new Response('No releases found (except continuous)', { status: 404 });
	}

	const versionRaw = filteredReleases[0].tag_name;

	// Backward compatibility: Strip any 'v' prefix, since the GUI doesn't expect one.
	const response = new Response(versionRaw.replace(/^v/, ''));

	// Works with the cache code earlier in the function to cache the response next time.
	console.debug(`Caching response for ${cacheAgeSeconds} seconds`);
	response.headers.set('Cache-Control', `public, max-age=${cacheAgeSeconds}`);
	await cache.put(request, response);

	return response;
}
