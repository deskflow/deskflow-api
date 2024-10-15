// SPDX-Copyright-Text: 2024 Symless Ltd.
// SPDX-License-Identifier: GPL-2.0-only

import { Octokit } from '@octokit/rest';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/version')) {
			return await version(url);
		} else {
			return new Response('Not found', { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;

async function version(url: URL) {
	const fake = url.searchParams.get('fake');
	if (fake) {
		return new Response(fake);
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
		return new Response(versionRaw.replace(/^v/, ''));
	} else {
		return new Response('No valid release found', { status: 404 });
	}
}
