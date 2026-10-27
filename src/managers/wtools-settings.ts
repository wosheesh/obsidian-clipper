import browser from '../utils/browser-polyfill';
import { normalizeWtoolsSettings, pinnedServerOrigin, WTOOLS_SETTINGS_KEY } from '../utils/wtools-clip';

/**
 * W-Tools connection on the options page: the only place the server URL and the
 * Ingest clip token are entered (wosheesh/wtools#1660).
 */
export async function initializeWtoolsSettings(): Promise<void> {
	const serverInput = document.getElementById('wtools-server-url') as HTMLInputElement | null;
	const tokenInput = document.getElementById('wtools-clip-token') as HTMLInputElement | null;
	const status = document.getElementById('wtools-settings-status');
	if (!serverInput || !tokenInput || !status) return;

	const stored = await browser.storage.local.get(WTOOLS_SETTINGS_KEY);
	const { settings, hasLegacyKeys } = normalizeWtoolsSettings(stored[WTOOLS_SETTINGS_KEY]);
	if (hasLegacyKeys) {
		await browser.storage.local.set({ [WTOOLS_SETTINGS_KEY]: settings });
	}
	serverInput.value = settings.serverUrl;
	tokenInput.value = settings.clipToken;

	const showStatus = () => {
		if (!pinnedServerOrigin(serverInput.value)) {
			status.textContent = 'Server must be http://127.0.0.1:<port> or http://localhost:<port>; the clipper will not send elsewhere.';
			status.classList.add('text-warning');
		} else {
			status.textContent = tokenInput.value.trim() ? '' : 'Add the clip token to send pages to Ingest.';
			status.classList.remove('text-warning');
		}
	};
	showStatus();

	const save = async () => {
		showStatus();
		await browser.storage.local.set({
			[WTOOLS_SETTINGS_KEY]: normalizeWtoolsSettings({
				serverUrl: serverInput.value,
				clipToken: tokenInput.value,
			}).settings,
		});
	};
	for (const input of [serverInput, tokenInput]) {
		input.addEventListener('change', save);
		input.addEventListener('input', showStatus);
	}
}
