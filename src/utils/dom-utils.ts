export function createElementWithClass(tagName: string, className: string): HTMLElement {
	const element = document.createElement(tagName);
	element.className = className;
	return element;
}

/**
 * The page's title as of RIGHT NOW, for SPAs whose metadata goes stale.
 *
 * YouTube never re-renders <head> on in-app navigation, so every title source
 * Defuddle prefers is left behind by the router:
 *
 *   - og:title / twitter:title keep the values from the page the tab was
 *     originally opened on — "YouTube" when you started on the feed, or the
 *     previously watched clip when you clicked through from another video;
 *   - ld+json is APPENDED rather than replaced, so the stale VideoObject stays
 *     first in the document, and that is the one Defuddle's YouTube extractor
 *     picks (`.find(item => item['@type'] === 'VideoObject')`).
 *
 * Verified in the live page: after clicking from video A to video B, og:title
 * still reported A while document.title and the metadata <h1> reported B.
 * Those two are the only sources YouTube's router actually updates, which is
 * why a manual page refresh "fixes" the title.
 *
 * Returns null when there is nothing better than what the parser found, so
 * callers can keep Defuddle's answer for ordinary pages.
 */
export function getFreshSpaTitle(doc: Document, url: string): string | null {
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		return null;
	}
	if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;

	// The watch page heading, updated by the router on every navigation.
	const heading = doc.querySelector<HTMLElement>(
		'h1.ytd-watch-metadata, ytd-watch-metadata h1, #title h1'
	)?.textContent?.trim();
	if (heading) return heading;

	// Shorts and other layouts have no such heading — document.title is still
	// current, it just carries the site suffix Defuddle would have stripped.
	const docTitle = (doc.title || '').replace(/\s*[|\-–—]\s*YouTube\s*$/, '').trim();
	if (docTitle && docTitle !== 'YouTube') return docTitle;

	return null;
}

export function createElementWithHTML(tagName: string, htmlContent: string, attributes: Record<string, string> = {}): HTMLElement {
	const element = document.createElement(tagName);

	const parser = new DOMParser();
	const doc = parser.parseFromString(htmlContent, 'text/html');
	
	// Move all child nodes from parsed content to the element
	Array.from(doc.body.childNodes).forEach(node => {
		element.appendChild(node.cloneNode(true));
	});
	
	Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
	return element;
}

export function createOption(value: string, text: string): HTMLOptionElement {
	const option = document.createElement('option');
	option.value = value;
	option.textContent = text;
	return option;
}

export function getElementXPath(element: Node): string {
	if (element.nodeType === Node.DOCUMENT_NODE) return '';
	if (element.nodeType !== Node.ELEMENT_NODE) {
		return getElementXPath(element.parentNode!);
	}

	let ix = 0;
	const siblings = element.parentNode?.childNodes || [];
	for (let i = 0; i < siblings.length; i++) {
		const sibling = siblings[i];
		if (sibling === element) {
			return getElementXPath(element.parentNode!) + '/' + (element as Element).tagName.toLowerCase() + '[' + (ix + 1) + ']';
		}
		if (sibling.nodeType === Node.ELEMENT_NODE && (sibling as Element).tagName === (element as Element).tagName) {
			ix++;
		}
	}
	return '';
}

export function getElementByXPath(xpath: string): Element | null {
	return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
}

export function isDarkColor(color: string): boolean {
	// Convert the color to RGB
	const rgb = color.match(/\d+/g);
	if (!rgb || rgb.length < 3) return false;

	// Calculate the perceived brightness
	const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;

	// Return true if the brightness is below 128 (assuming 0-255 range)
	return brightness < 128;
}

export function wrapElementWithMark(element: Element): void {
	const mark = document.createElement('mark');

	while (element.firstChild) {
		mark.appendChild(element.firstChild);
	}
	
	element.appendChild(mark);
}

export function wrapTextWithMark(element: Element, highlight: { startOffset: number; endOffset: number }): void {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let currentOffset = 0;
	let startNode = null;
	let endNode = null;
	let startOffset = 0;
	let endOffset = 0;
	
	let node;
	while (node = walker.nextNode() as Text) {
		const length = node.length;
		
		if (!startNode && currentOffset + length > highlight.startOffset) {
			startNode = node;
			startOffset = highlight.startOffset - currentOffset;
		}
		
		if (!endNode && currentOffset + length >= highlight.endOffset) {
			endNode = node;
			endOffset = highlight.endOffset - currentOffset;
			break;
		}
		
		currentOffset += length;
	}
	
	if (startNode && endNode) {
		const range = document.createRange();
		range.setStart(startNode, startOffset);
		range.setEnd(endNode, endOffset);
		
		const mark = document.createElement('mark');
		range.surroundContents(mark);
	}
}