import { describe, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import {
	DEFAULT_WTOOLS_SERVER,
	buildClipMetadata,
	splitAuthors,
	describeClipResult,
	normalizeWtoolsSettings,
	parseClipQuestions,
	pinnedServerOrigin,
	relayClipRequest,
	renderClipQuestions,
} from './wtools-clip';

// Synthetic values only.
const TOKEN = 'test-clip-token';
const settings = { serverUrl: 'http://127.0.0.1:8052', clipToken: TOKEN };

function fakeFetch(status = 200, body: unknown = { item_id: 'item-1', status: 'queued' }) {
	return vi.fn(async (_url: string, _init?: RequestInit) =>
		new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
	);
}

describe('pinnedServerOrigin', () => {
	test.each([
		['http://127.0.0.1:8052', 'http://127.0.0.1:8052'],
		['http://localhost:8052/', 'http://localhost:8052'],
		[' http://127.0.0.1:9000 ', 'http://127.0.0.1:9000'],
	])('accepts loopback %s', (input, origin) => {
		expect(pinnedServerOrigin(input)).toBe(origin);
	});

	test.each([
		'https://127.0.0.1:8052',
		'http://127.0.0.1',
		'http://example.com:8052',
		'http://127.0.0.1.example.com:8052',
		'http://localhost.example.com:8052',
		'http://10.0.0.5:8052',
		'http://[::1]:8052',
		'http://user:pw@127.0.0.1:8052',
		'http://127.0.0.1:8052/bridge',
		'http://127.0.0.1:8052/?x=1',
		'file:///tmp/x',
		'not a url',
		'',
	])('refuses %s', input => {
		expect(pinnedServerOrigin(input)).toBeNull();
	});
});

describe('normalizeWtoolsSettings', () => {
	test('defaults the server and flags the old webhook secret for removal', () => {
		const { settings: s, hasLegacyKeys } = normalizeWtoolsSettings({
			serverUrl: '',
			secret: 'old-secret',
			defaultDestination: 'X',
		});
		expect(s).toEqual({ serverUrl: DEFAULT_WTOOLS_SERVER, clipToken: '' });
		expect(hasLegacyKeys).toBe(true);
		expect(JSON.stringify(s)).not.toContain('old-secret');
	});

	test('keeps current settings and survives garbage', () => {
		expect(normalizeWtoolsSettings({ serverUrl: 'http://localhost:1234', clipToken: ` ${TOKEN} ` })).toEqual({
			settings: { serverUrl: 'http://localhost:1234', clipToken: TOKEN },
			hasLegacyKeys: false,
		});
		expect(normalizeWtoolsSettings(undefined).settings.serverUrl).toBe(DEFAULT_WTOOLS_SERVER);
		expect(normalizeWtoolsSettings('x').hasLegacyKeys).toBe(false);
	});
});

describe('relayClipRequest', () => {
	test('GETs the questions from the configured server with the token', async () => {
		const fetchFn = fakeFetch(200, { questions: [] });
		const res = await relayClipRequest({ action: 'wtoolsClip', op: 'questions' }, settings, fetchFn as any);
		expect(res).toEqual({ ok: true, status: 200, data: { questions: [] } });
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe('http://127.0.0.1:8052/ingest/clip/questions');
		expect(init?.method).toBe('GET');
		expect((init?.headers as Record<string, string>)['X-Wtools-Token']).toBe(TOKEN);
		expect(init?.redirect).toBe('error');
	});

	test('POSTs the page as JSON text with source_url, title and answers', async () => {
		const fetchFn = fakeFetch();
		const payload = { text: '# Hi', source_url: 'https://example.org/a', title: 'A', answers: { preset: 'article' } };
		const res = await relayClipRequest({ action: 'wtoolsClip', op: 'submit', payload }, settings, fetchFn as any);
		expect(res.ok).toBe(true);
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe('http://127.0.0.1:8052/ingest/clip/submit');
		expect(init?.method).toBe('POST');
		expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
		expect(JSON.parse(init?.body as string)).toEqual(payload);
	});

	test('refuses a message that names its own URL', async () => {
		const fetchFn = fakeFetch();
		for (const extra of [{ url: 'https://attacker.example/x' }, { serverUrl: 'http://127.0.0.1:1' }]) {
			const res = await relayClipRequest({ action: 'wtoolsClip', op: 'questions', ...extra }, settings, fetchFn as any);
			expect(res.ok).toBe(false);
			expect(res.status).toBe(0);
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test('refuses a non-loopback configured server', async () => {
		const fetchFn = fakeFetch();
		const res = await relayClipRequest(
			{ action: 'wtoolsClip', op: 'questions' },
			{ serverUrl: 'http://example.com:8052', clipToken: TOKEN },
			fetchFn as any
		);
		expect(res.status).toBe(0);
		expect(res.error).toMatch(/127\.0\.0\.1/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test('refuses without a token, a bad payload or an unknown op', async () => {
		const fetchFn = fakeFetch();
		const noToken = await relayClipRequest({ action: 'wtoolsClip', op: 'questions' }, { ...settings, clipToken: '' }, fetchFn as any);
		expect(noToken.error).toMatch(/clip token/);
		const badPayload = await relayClipRequest(
			{ action: 'wtoolsClip', op: 'submit', payload: { text: 'x', source_url: 'u', title: 't', answers: [] } },
			settings,
			fetchFn as any
		);
		expect(badPayload.status).toBe(0);
		const badOp = await relayClipRequest({ action: 'wtoolsClip', op: 'bridge' }, settings, fetchFn as any);
		expect(badOp.status).toBe(0);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test('passes server errors through and reports network failures', async () => {
		const res = await relayClipRequest({ action: 'wtoolsClip', op: 'questions' }, settings, fakeFetch(503, { detail: 'Ingest clip token is not configured' }) as any);
		expect(res).toEqual({ ok: false, status: 503, data: { detail: 'Ingest clip token is not configured' } });

		const failing = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
		const down = await relayClipRequest({ action: 'wtoolsClip', op: 'questions' }, settings, failing as any);
		expect(down.status).toBe(0);
		expect(down.error).toContain('Failed to fetch');
	});
});

describe('questions renderer', () => {
	const schema = {
		schema_version: 1,
		questions: [
			{ name: 'preset', label: 'Preset', kind: 'choice', default: 'article', choices: [
				{ value: 'book', label: 'book (Book)' },
				{ value: 'article', label: 'article (Article)' },
			] },
			{ name: 'ocr', label: 'OCR', kind: 'choice', default: 'auto', choices: ['auto', 'never'] },
			{ name: 'force_marker', label: 'OCR straight away', kind: 'boolean', default: false },
			{ name: 'note', label: 'Note', kind: 'text' },
			{ name: 'broken', kind: 'choice', choices: [] },
			{ label: 'no name' },
		],
		verify: true,
		limits: { pdf_max_bytes: 52428800, text_max_bytes: 5242880 },
	};

	test('parses the schema and drops malformed questions', () => {
		const parsed = parseClipQuestions(schema);
		expect(parsed.questions.map(q => q.name)).toEqual(['preset', 'ocr', 'force_marker', 'note']);
		expect(parsed.questions[1].choices).toEqual([{ value: 'auto', label: 'auto' }, { value: 'never', label: 'never' }]);
		expect(parsed.textMaxBytes).toBe(5242880);
		expect(parseClipQuestions(null).questions).toEqual([]);
	});

	test('renders labels, choices and server defaults, and reads answers back', () => {
		const { document } = parseHTML('<html><body><div id="box"></div></body></html>');
		const box = document.getElementById('box') as unknown as HTMLElement;
		const read = renderClipQuestions(document as unknown as Document, parseClipQuestions(schema).questions, box, 'p');

		const preset = box.querySelector('select[data-question="preset"]') as HTMLSelectElement;
		expect(Array.from(preset.querySelectorAll('option')).map(o => o.textContent)).toEqual(['book (Book)', 'article (Article)']);
		expect(Array.from(box.querySelectorAll('label')).map(l => l.textContent)).toEqual(['Preset', 'OCR', 'OCR straight away', 'Note']);

		expect(read()).toEqual({ preset: 'article', ocr: 'auto', force_marker: false });

		// linkedom's select.value is read-only; pick the option instead.
		const [book, article] = Array.from(preset.querySelectorAll('option')) as HTMLOptionElement[];
		article.selected = false;
		book.selected = true;
		(box.querySelector('input[data-question="force_marker"]') as HTMLInputElement).checked = true;
		(box.querySelector('input[data-question="note"]') as HTMLInputElement).value = ' hello ';
		expect(read()).toEqual({ preset: 'book', ocr: 'auto', force_marker: true, note: 'hello' });
	});

	test('renders no password or token field', () => {
		const { document } = parseHTML('<html><body><div id="box"></div></body></html>');
		const box = document.getElementById('box') as unknown as HTMLElement;
		renderClipQuestions(document as unknown as Document, parseClipQuestions(schema).questions, box, 'p');
		expect(box.querySelector('input[type="password"]')).toBeNull();
		expect(box.innerHTML).not.toContain(TOKEN);
	});
});

describe('describeClipResult', () => {
	test('queued with the item id', () => {
		expect(describeClipResult({ ok: true, status: 200, data: { item_id: 'item-42', status: 'queued', stage: 'x', runs: [] } }))
			.toEqual({ ok: true, message: 'Queued in Ingest as item-42.' });
	});

	test('known source and failed run', () => {
		expect(describeClipResult({ ok: true, status: 200, data: { status: 'skipped_existing', matched: 'x', item_id: 'item-7' } }).message)
			.toBe('Already in Ingest as item-7; nothing new was queued.');
		const runError = describeClipResult({ ok: true, status: 200, data: { item_id: 'item-8', run_error: 'no worker' } });
		expect(runError.ok).toBe(false);
		expect(runError.message).toContain('item-8');
	});

	test('503 says the clip token is not configured in wtools', () => {
		const res = describeClipResult({ ok: false, status: 503, data: { detail: 'Ingest clip token is not configured' } });
		expect(res).toEqual({ ok: false, message: 'The Ingest clip token is not configured in wtools (WTOOLS_INGEST_CLIP_TOKEN).' });
		expect(describeClipResult({ ok: false, status: 503, data: { detail: 'Windmill token missing' } }).message)
			.toBe('W-Tools is not ready: Windmill token missing');
	});

	test('other server errors in one sentence', () => {
		expect(describeClipResult({ ok: false, status: 401, data: { detail: 'x' } }).message).toMatch(/clip token/);
		expect(describeClipResult({ ok: false, status: 403, data: { detail: 'Forbidden origin' } }).message)
			.toBe('W-Tools refused the request: Forbidden origin.');
		expect(describeClipResult({ ok: false, status: 400, data: { detail: 'unknown answer: foo' } }).message)
			.toBe('W-Tools error 400: unknown answer: foo');
		expect(describeClipResult({ ok: false, status: 0, error: 'Could not reach W-Tools' }).message).toBe('Could not reach W-Tools');
		expect(describeClipResult(undefined).ok).toBe(false);
	});
});

describe('clip metadata', () => {
	test('builder maps author, published and site, omitting empty values', () => {
		expect(buildClipMetadata({ author: 'Ann Example', published: '2026-01-02', site: 'Example Times' })).toEqual({
			authors: ['Ann Example'], published: '2026-01-02', publication: 'Example Times',
		});
		expect(buildClipMetadata({ author: '  ', published: '', site: undefined })).toBeUndefined();
		expect(buildClipMetadata(null)).toBeUndefined();
	});

	test('splits only on clear separators', () => {
		expect(splitAuthors('Ann Example, PhD')).toEqual(['Ann Example, PhD']);
		expect(splitAuthors('Ann Example and Bob Sample')).toEqual(['Ann Example', 'Bob Sample']);
		expect(splitAuthors('Ann Example & Bob Sample; Cy Test')).toEqual(['Ann Example', 'Bob Sample', 'Cy Test']);
		expect(splitAuthors('Alexander Anderson')).toEqual(['Alexander Anderson']);
	});

	test('builder enforces limits', () => {
		const many = Array.from({ length: 12 }, (_, i) => `Author ${i}`).join('; ');
		const m = buildClipMetadata({ author: many, published: 'x'.repeat(100), site: 's'.repeat(300) })!;
		expect(m.authors).toHaveLength(10);
		expect(m.published).toHaveLength(64);
		expect(m.publication).toHaveLength(200);
	});

	const base = { text: 't', source_url: 'u', title: 'T', answers: {} };
	async function sent(metadata: unknown) {
		const fetchFn = fakeFetch();
		await relayClipRequest({ action: 'wtoolsClip', op: 'submit', payload: { ...base, metadata } }, settings, fetchFn as any);
		return JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
	}

	test('relay forwards valid metadata and drops unknown keys', async () => {
		const body = await sent({ authors: ['Ann'], published: '2026', publication: 'P', extra: 1 });
		expect(body.metadata).toEqual({ authors: ['Ann'], published: '2026', publication: 'P' });
	});

	test('relay drops invalid or over-limit values and absent metadata', async () => {
		expect((await sent({ authors: 'Ann', published: 5, publication: 'p'.repeat(201) })).metadata).toBeUndefined();
		expect((await sent({ authors: Array(11).fill('a'), published: 'ok' })).metadata).toEqual({ published: 'ok' });
		expect((await sent('nope')).metadata).toBeUndefined();
		const fetchFn = fakeFetch();
		await relayClipRequest({ action: 'wtoolsClip', op: 'submit', payload: base }, settings, fetchFn as any);
		expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual(base);
	});
});
