// SPDX-Copyright-Text: 2024 Symless Ltd.
// SPDX-License-Identifier: GPL-2.0-only

import { Octokit } from '@octokit/rest';

// With no API token, we can only make 60 requests per hour, but if we cache the response,
// we can limit our requests to once every 2 minutes (which is 30 per hour).
// We could limit this further to like 1 per hour, but this might confuse developers not aware
// of the cache ("Why is the API version response not updating?")
const cacheAgeSeconds = 60 * 2; // 2 mins (30 requests per hour)

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
	const cacheKey = new Request(request);
	const cachedResponse = await cache.match(cacheKey);
	if (cachedResponse) {
		console.debug('Cache hit for version');
		return cachedResponse;
	}

	const octokit = new Octokit();
	const { data: releases } = await octokit.repos.listReleases({
		owner: 'deskflow',
		repo: 'deskflow',
		per_page: 2,
	});

	const filteredReleases = releases.filter((release) => release.tag_name !== 'continuous');
	if (filteredReleases.length > 0) {
		const versionRaw = filteredReleases[0].tag_name;

		// Backward compatibility: Strip any 'v' prefix, since the GUI doesn't expect one.
		const response = new Response(versionRaw.replace(/^v/, ''));

		// Works with the cache code earlier in the function to cache the response next time.
		console.debug(`Caching response for ${cacheAgeSeconds} seconds`);
		response.headers.set('Cache-Control', `public, max-age=${cacheAgeSeconds}`);
		await cache.put(cacheKey, response.clone());

		return response;
	} else {
		return new Response('No valid release found', { status: 404 });
	}
}
