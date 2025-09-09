// URL normalization function based on Jina DeepResearch
export function normalizeUrl(urlString: string, options = {
	removeAnchors: true,
	removeSessionIDs: true,
	removeUTMParams: true,
	removeTrackingParams: true,
	removeXAnalytics: true
}) {
	try {
		urlString = urlString.replace(/\s+/g, '').trim();

		if (!urlString?.trim()) {
			throw new Error('Empty URL');
		}

		// Handle x.com and twitter.com URLs with /analytics
		if (options.removeXAnalytics) {
			const xComPattern = /^(https?:\/\/(www\.)?(x\.com|twitter\.com)\/([^/]+)\/status\/(\d+))\/analytics(\/)?(\?.*)?(#.*)?$/i;
			const xMatch = urlString.match(xComPattern);
			if (xMatch) {
				let cleanUrl = xMatch[1];
				if (xMatch[7]) cleanUrl += xMatch[7];
				if (xMatch[8]) cleanUrl += xMatch[8];
				urlString = cleanUrl;
			}
		}

		const url = new URL(urlString);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('Unsupported protocol');
		}

		url.hostname = url.hostname.toLowerCase();
		if (url.hostname.startsWith('www.')) {
			url.hostname = url.hostname.slice(4);
		}

		if ((url.protocol === 'http:' && url.port === '80') ||
			(url.protocol === 'https:' && url.port === '443')) {
			url.port = '';
		}

		// Query parameter filtering
		const searchParams = new URLSearchParams(url.search);
		const filteredParams = Array.from(searchParams.entries())
			.filter(([key]) => {
				if (key === '') return false;
				if (options.removeSessionIDs && /^(s|session|sid|sessionid|phpsessid|jsessionid|aspsessionid|asp\.net_sessionid)$/i.test(key)) {
					return false;
				}
				if (options.removeUTMParams && /^utm_/i.test(key)) {
					return false;
				}
				if (options.removeTrackingParams && /^(ref|referrer|fbclid|gclid|cid|mcid|source|medium|campaign|term|content|sc_rid|mc_[a-z]+)$/i.test(key)) {
					return false;
				}
				return true;
			})
			.sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

		url.search = new URLSearchParams(filteredParams).toString();

		if (options.removeAnchors) {
			url.hash = '';
		}

		return url.toString();
	} catch (error) {
		return undefined;
	}
}
