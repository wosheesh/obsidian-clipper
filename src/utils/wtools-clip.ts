/**
 * W-Tools Ingest clip (wosheesh/wtools docs/INGEST-CLIP.md, wosheesh/wtools#1660).
 *
 * The clip token lives in extension storage and is read only by the background
 * relay; the in-page panel never sees it. The relay talks to one server: the
 * loopback URL from the options page, never a URL taken from a message.
 */

export const WTOOLS_SETTINGS_KEY = 'wtools_settings';
export const DEFAULT_WTOOLS_SERVER = 'http://127.0.0.1:8052';

const QUESTIONS_PATH = '/ingest/clip/questions';
const SUBMIT_PATH = '/ingest/clip/submit';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];
// Keys left by the old /bridge integration: the HMAC webhook secret (exposed to
// pages by the old panel, to be rotated, never reused) and the vault folder.
const LEGACY_KEYS = ['secret', 'defaultDestination'];

export interface WtoolsSettings {
	serverUrl: string;
	clipToken: string;
}

/** Settings from storage, plus whether legacy keys should be dropped from it. */
export function normalizeWtoolsSettings(raw: unknown): { settings: WtoolsSettings; hasLegacyKeys: boolean } {
	const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	return {
		settings: {
			serverUrl: typeof obj.serverUrl === 'string' && obj.serverUrl.trim() ? obj.serverUrl.trim() : DEFAULT_WTOOLS_SERVER,
			clipToken: typeof obj.clipToken === 'string' ? obj.clipToken.trim() : '',
		},
		hasLegacyKeys: LEGACY_KEYS.some(key => key in obj),
	};
}

/**
 * The origin to send to, or null unless the URL is exactly
 * http://127.0.0.1:<port> or http://localhost:<port> (no path, query or credentials).
 */
export function pinnedServerOrigin(serverUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(serverUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:') return null;
	if (!LOOPBACK_HOSTS.includes(url.hostname)) return null;
	if (!url.port) return null;
	if (url.username || url.password) return null;
	if (url.pathname !== '/' || url.search || url.hash) return null;
	return url.origin;
}

export interface ClipSubmitPayload {
	text: string;
	source_url: string;
	title: string;
	answers: Record<string, unknown>;
	metadata?: ClipMetadata;
}

/** Page metadata for Ingest to prefill (wosheesh/wtools#1684). Limits match the server. */
export interface ClipMetadata {
	authors?: string[];
	published?: string;
	publication?: string;
}

const MAX_AUTHORS = 10;
const MAX_AUTHOR_CHARS = 200;
const MAX_PUBLISHED_CHARS = 64;
const MAX_PUBLICATION_CHARS = 200;

function cleanString(value: unknown, max: number): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Split a byline only on clear multi-author separators; "Name, PhD" stays whole. */
export function splitAuthors(byline: string): string[] {
	return byline
		.split(/\s+and\s+|\s+&\s+|;/)
		.map(name => name.trim().slice(0, MAX_AUTHOR_CHARS))
		.filter(Boolean)
		.slice(0, MAX_AUTHORS);
}

/** Metadata from the extracted page fields; empty values are omitted. Undefined when nothing is left. */
export function buildClipMetadata(data: { author?: string; published?: string; site?: string } | null | undefined): ClipMetadata | undefined {
	if (!data) return undefined;
	const metadata: ClipMetadata = {};
	const authors = typeof data.author === 'string' ? splitAuthors(data.author) : [];
	if (authors.length) metadata.authors = authors;
	const published = cleanString(data.published, MAX_PUBLISHED_CHARS);
	if (published) metadata.published = published;
	const publication = cleanString(data.site, MAX_PUBLICATION_CHARS);
	if (publication) metadata.publication = publication;
	return Object.keys(metadata).length ? metadata : undefined;
}

/** Keep only the known keys that meet the limits; undefined when nothing is left. */
function validMetadata(raw: unknown): ClipMetadata | undefined {
	if (!isPlainObject(raw)) return undefined;
	const metadata: ClipMetadata = {};
	if (Array.isArray(raw.authors) && raw.authors.length <= MAX_AUTHORS
		&& raw.authors.every(a => typeof a === 'string' && a.trim() && a.length <= MAX_AUTHOR_CHARS)) {
		metadata.authors = raw.authors as string[];
	}
	if (typeof raw.published === 'string' && raw.published && raw.published.length <= MAX_PUBLISHED_CHARS) {
		metadata.published = raw.published;
	}
	if (typeof raw.publication === 'string' && raw.publication && raw.publication.length <= MAX_PUBLICATION_CHARS) {
		metadata.publication = raw.publication;
	}
	return Object.keys(metadata).length ? metadata : undefined;
}

export interface ClipRelayResponse {
	ok: boolean;
	/** HTTP status, or 0 when nothing was sent (refused, not configured, network error). */
	status: number;
	data?: unknown;
	error?: string;
}

const RELAY_KEYS = ['action', 'op', 'payload'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validSubmitPayload(payload: unknown): ClipSubmitPayload | null {
	if (!isPlainObject(payload)) return null;
	const { text, source_url, title, answers } = payload;
	if (typeof text !== 'string' || typeof source_url !== 'string' || typeof title !== 'string') return null;
	if (!isPlainObject(answers)) return null;
	const metadata = validMetadata(payload.metadata);
	return metadata ? { text, source_url, title, answers, metadata } : { text, source_url, title, answers };
}

/**
 * Perform one `wtoolsClip` message for the background script: build the
 * request from settings, add the token here, and refuse anything that tries to
 * choose its own destination.
 */
export async function relayClipRequest(
	request: Record<string, unknown>,
	settings: WtoolsSettings,
	fetchFn: typeof fetch
): Promise<ClipRelayResponse> {
	const refused = (error: string): ClipRelayResponse => ({ ok: false, status: 0, error });

	if (Object.keys(request).some(key => !RELAY_KEYS.includes(key))) {
		return refused('Refused: the W-Tools relay only sends to the server set in the extension options.');
	}
	const origin = pinnedServerOrigin(settings.serverUrl);
	if (!origin) {
		return refused('The W-Tools server must be http://127.0.0.1:<port> or http://localhost:<port>; fix it in the extension options.');
	}
	if (!settings.clipToken) {
		return refused('Set the Ingest clip token in the extension options (General → W-Tools).');
	}

	const headers: Record<string, string> = { 'X-Wtools-Token': settings.clipToken };
	let init: RequestInit;
	let path: string;
	if (request.op === 'questions') {
		path = QUESTIONS_PATH;
		init = { method: 'GET', headers };
	} else if (request.op === 'submit') {
		const payload = validSubmitPayload(request.payload);
		if (!payload) return refused('Refused: the clip needs text, source_url, title and answers.');
		path = SUBMIT_PATH;
		headers['Content-Type'] = 'application/json';
		init = { method: 'POST', headers, body: JSON.stringify(payload) };
	} else {
		return refused('Refused: unknown W-Tools request.');
	}

	let response: Response;
	try {
		// A redirect could lead off loopback with the token attached.
		response = await fetchFn(origin + path, { ...init, redirect: 'error', credentials: 'omit' });
	} catch (err) {
		return refused(`Could not reach W-Tools at ${origin}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const body = await response.text();
	let data: unknown = body;
	try {
		data = body ? JSON.parse(body) : null;
	} catch {
		// Keep the raw text for the error message.
	}
	return { ok: response.ok, status: response.status, data };
}

// ---------------------------------------------------------------------------
// Questions (GET /ingest/clip/questions), rendered generically
// ---------------------------------------------------------------------------

export interface ClipChoice {
	value: string;
	label: string;
}

export interface ClipQuestion {
	name: string;
	label: string;
	kind: string;
	default?: unknown;
	choices?: ClipChoice[];
}

export interface ClipQuestions {
	questions: ClipQuestion[];
	textMaxBytes?: number;
}

/** The parts of the server's schema the panel uses; malformed entries are dropped. */
export function parseClipQuestions(data: unknown): ClipQuestions {
	const obj = isPlainObject(data) ? data : {};
	const questions: ClipQuestion[] = [];
	for (const raw of Array.isArray(obj.questions) ? obj.questions : []) {
		if (!isPlainObject(raw) || typeof raw.name !== 'string' || !raw.name) continue;
		const question: ClipQuestion = {
			name: raw.name,
			label: typeof raw.label === 'string' && raw.label ? raw.label : raw.name,
			kind: typeof raw.kind === 'string' ? raw.kind : 'text',
			default: raw.default,
		};
		if (question.kind === 'choice') {
			question.choices = (Array.isArray(raw.choices) ? raw.choices : [])
				.map((c: unknown) => {
					if (typeof c === 'string') return { value: c, label: c };
					if (isPlainObject(c) && typeof c.value === 'string') {
						return { value: c.value, label: typeof c.label === 'string' ? c.label : c.value };
					}
					return null;
				})
				.filter((c): c is ClipChoice => c !== null);
			if (question.choices.length === 0) continue;
		}
		questions.push(question);
	}
	const limits = isPlainObject(obj.limits) ? obj.limits : {};
	const textMaxBytes = typeof limits.text_max_bytes === 'number' ? limits.text_max_bytes : undefined;
	return { questions, textMaxBytes };
}

/**
 * Render each question as a labelled control inside `parent` and return a
 * function that reads the answers. Choice → select, boolean → checkbox,
 * anything else → text field (sent only when filled in).
 */
export function renderClipQuestions(
	doc: Document,
	questions: ClipQuestion[],
	parent: HTMLElement,
	classPrefix: string
): () => Record<string, unknown> {
	const readers: Array<(answers: Record<string, unknown>) => void> = [];

	questions.forEach((question, index) => {
		const field = doc.createElement('div');
		field.className = `${classPrefix}-field`;
		const id = `${classPrefix}-q-${index}`;

		const label = doc.createElement('label');
		label.textContent = question.label;
		label.setAttribute('for', id);

		if (question.kind === 'choice' && question.choices) {
			const select = doc.createElement('select');
			select.id = id;
			select.className = `${classPrefix}-select`;
			select.dataset.question = question.name;
			for (const choice of question.choices) {
				const option = doc.createElement('option');
				option.value = choice.value;
				option.textContent = choice.label;
				if (choice.value === question.default) option.selected = true;
				select.appendChild(option);
			}
			field.appendChild(label);
			field.appendChild(select);
			readers.push(answers => { answers[question.name] = select.value; });
		} else if (question.kind === 'boolean') {
			field.classList.add(`${classPrefix}-field-checkbox`);
			const checkbox = doc.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.id = id;
			checkbox.dataset.question = question.name;
			checkbox.checked = question.default === true;
			field.appendChild(checkbox);
			field.appendChild(label);
			readers.push(answers => { answers[question.name] = checkbox.checked; });
		} else {
			const input = doc.createElement('input');
			input.type = 'text';
			input.id = id;
			input.className = `${classPrefix}-input`;
			input.dataset.question = question.name;
			input.value = typeof question.default === 'string' ? question.default : '';
			field.appendChild(label);
			field.appendChild(input);
			readers.push(answers => { if (input.value.trim()) answers[question.name] = input.value.trim(); });
		}
		parent.appendChild(field);
	});

	return () => {
		const answers: Record<string, unknown> = {};
		readers.forEach(read => read(answers));
		return answers;
	};
}

// ---------------------------------------------------------------------------
// Result (POST /ingest/clip/submit) as one sentence
// ---------------------------------------------------------------------------

function errorDetail(data: unknown): string {
	if (isPlainObject(data)) {
		const detail = data.detail ?? data.error;
		if (typeof detail === 'string') return detail;
		if (detail !== undefined) return JSON.stringify(detail).slice(0, 300);
	}
	if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300);
	return '';
}

export function describeClipResult(response: ClipRelayResponse | undefined): { ok: boolean; message: string } {
	if (!response) return { ok: false, message: 'No answer from the extension background.' };
	if (response.status === 0) return { ok: false, message: response.error || 'The request was not sent.' };

	const detail = errorDetail(response.data);
	const data = isPlainObject(response.data) ? response.data : {};
	const itemId = typeof data.item_id === 'string' ? data.item_id : '';

	if (response.ok) {
		if (data.status === 'skipped_existing') {
			return { ok: true, message: `Already in Ingest${itemId ? ` as ${itemId}` : ''}; nothing new was queued.` };
		}
		if (data.run_error) {
			return { ok: false, message: `Ingest item ${itemId} was created but its run did not start: ${String(data.run_error)}` };
		}
		return { ok: true, message: itemId ? `Queued in Ingest as ${itemId}.` : 'Queued in Ingest.' };
	}

	switch (response.status) {
		case 503:
			if (!detail || /clip token/i.test(detail)) {
				return { ok: false, message: 'The Ingest clip token is not configured in wtools (WTOOLS_INGEST_CLIP_TOKEN).' };
			}
			return { ok: false, message: `W-Tools is not ready: ${detail}` };
		case 401:
			return { ok: false, message: 'W-Tools rejected the clip token; check it in the extension options.' };
		case 403:
			return { ok: false, message: `W-Tools refused the request${detail ? `: ${detail}` : ''}.` };
		case 413:
			return { ok: false, message: 'The page is too large for Ingest.' };
		default:
			return { ok: false, message: `W-Tools error ${response.status}${detail ? `: ${detail}` : ''}` };
	}
}
