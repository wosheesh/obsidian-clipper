import { describe, expect, test } from 'vitest';
import { getFreshSpaTitle } from './dom-utils';

/**
 * Fake document exposing only what getFreshSpaTitle touches, so these run in
 * the default node environment (the repo has no jsdom).
 */
function fakeDoc(options: { heading?: string; title?: string }): Document {
	return {
		title: options.title ?? '',
		querySelector: () =>
			options.heading === undefined
				? null
				: ({ textContent: options.heading } as unknown as Element),
	} as unknown as Document;
}

describe('getFreshSpaTitle', () => {
	test('leaves non-SPA pages to the parser', () => {
		const doc = fakeDoc({ heading: 'Something', title: 'Something' });
		expect(getFreshSpaTitle(doc, 'https://aeon.co/essays/our-tools')).toBeNull();
	});

	test('prefers the watch-page heading, which the router keeps current', () => {
		// The bug: og:title and the first ld+json VideoObject still say
		// "Rick Astley - Never Gonna Give You Up" after navigating away from it.
		const doc = fakeDoc({
			heading: 'Howl - Chill Electronic Live Session',
			title: 'Howl - Chill Electronic Live Session - YouTube',
		});
		expect(getFreshSpaTitle(doc, 'https://www.youtube.com/watch?v=WjPUgEDQ4yE')).toBe(
			'Howl - Chill Electronic Live Session'
		);
	});

	test('falls back to document.title with the site suffix stripped', () => {
		// Shorts and other layouts have no ytd-watch-metadata heading.
		const doc = fakeDoc({ title: '3 Offroad skills you should practice - YouTube' });
		expect(getFreshSpaTitle(doc, 'https://www.youtube.com/shorts/abc123')).toBe(
			'3 Offroad skills you should practice'
		);
	});

	test('returns null on the feed rather than overriding with "YouTube"', () => {
		const doc = fakeDoc({ title: 'YouTube' });
		expect(getFreshSpaTitle(doc, 'https://www.youtube.com')).toBeNull();
	});

	test('trims whitespace-only headings instead of returning them', () => {
		const doc = fakeDoc({ heading: '   ', title: 'Real Title - YouTube' });
		expect(getFreshSpaTitle(doc, 'https://www.youtube.com/watch?v=x')).toBe('Real Title');
	});

	test('survives a malformed URL', () => {
		expect(getFreshSpaTitle(fakeDoc({ title: 'x' }), 'not a url')).toBeNull();
	});

	test('covers the short youtu.be host too', () => {
		const doc = fakeDoc({ heading: 'Clip name' });
		expect(getFreshSpaTitle(doc, 'https://youtu.be/WjPUgEDQ4yE')).toBe('Clip name');
	});
});
