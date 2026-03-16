// content.js

if (!window.hasRunImageGallery) {
	const CONCURRENCY_LIMIT = 5;	// max simultaneous downloads.
	const DEBUG = false;		// set this to false for production environment.

	window.hasRunImageGallery = true;
	let debug_log = 'Index\tSource\tMethod\tResult\tReason\tURL\tAncestors\n';
	let debug_log_index = 0;
	const GALLERY_HOST_ID = 'image-gallery-extension-host';
	let mouse = { x: 0, y: 0 };
	let scale = 1.0;
	let translateX = 0;
	let translateY = 0;
	let manualVisibilityOverrides = new Map();
	let currentlyHoveredImgWrapper = null;
	let allImageData = [];
	let allDiscoveredImages = [];
	let imageRecordsByKey = new Map();
	let allScrapedUrls = []; // Master list of URLs in their original DOM order
	let pageObserver = null;
	let sessionActiveProfile = null; // To track the currently loaded profile
	let hasRunFullScan = false; // To track if the gallery has been opened and processed
	let galleryHost = null; // Keep a reference to the host element
	let currentViewMode = 'gallery';
	let logSortState = { column: 'domIndex', direction: 'asc' };
	let logHighlightState = null;
	let activeSaveError = '';
	let saveInputAutofillArmed = false;
	let saveCollisionQueryKey = '';
	let saveCollisionPaths = new Set();
	let saveCollisionRequestId = 0;
	let popupTemporaryShownRecord = null;
	const originalGuessCache = new Map();
	const PAGE_LOCK_STYLE_ID = 'ig-page-lock-style';

	// --- Persistent Session Settings ---
	let settings = {
		gridCols: 5,
		gridRows: 4,
		minWidth: 200,
		minHeight: 200,
		sortBy: 'dom',
		deriveOriginals: true,
		includeRegex: '',
		excludeRegex: ''
	};
	// Add throttle utility
	function throttle(func, limit) {
		let inThrottle;
		return function (...args) {
			if (!inThrottle) {
				func.apply(this, args);
				inThrottle = true;
				setTimeout(() => inThrottle = false, limit);
			}
		}
	}

	function getAncestorPath(el) {
		const parts = [];
		while (el) {
			if (el.nodeType !== 1) break; // skip non-elements

			let s = el.tagName.toLowerCase();
			// if (el.id) s += `#${el.id}`;
			// if (el.classList.length) s += '.' + [...el.classList].join('.');

			parts.unshift(s);

			const parent = el.parentElement;
			if (!parent) break;

			// get index among element-type siblings
			const index = [...parent.children].indexOf(el) + 1;
			parts.unshift(`[${index}]`);

			el = parent;
		}
		return parts.join(' ');
	}

	function escapeHtml(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function ensurePageOverlayStyles() {
		if (document.getElementById(PAGE_LOCK_STYLE_ID)) return;

		const style = document.createElement('style');
		style.id = PAGE_LOCK_STYLE_ID;
		style.textContent = `
			.amer-image-gallery-hide {
				display: none !important;
			}
			html.amer-image-gallery-scroll-lock,
			body.amer-image-gallery-scroll-lock {
				overflow: hidden !important;
				overscroll-behavior: none !important;
			}
		`;
		(document.head || document.documentElement).appendChild(style);
	}

	function setPageScrollLock(isLocked) {
		document.documentElement.classList.toggle('amer-image-gallery-scroll-lock', Boolean(isLocked));
		document.body?.classList.toggle('amer-image-gallery-scroll-lock', Boolean(isLocked));
	}

	function getUrlBasePrefix(urlObj) {
		if (!urlObj) return '';
		if (urlObj.origin && urlObj.origin !== 'null') return urlObj.origin;
		return `${urlObj.protocol}//${urlObj.host || ''}`;
	}

	function getUrlDirectoryBase(urlObj, directoryPath = '') {
		return `${getUrlBasePrefix(urlObj)}${directoryPath}`;
	}

	function resolveCandidateUrl(urlText, baseHref) {
		const raw = String(urlText || '').trim();
		if (!raw) {
			throw new Error('URL is empty');
		}

		// Local files often appear as "D:/..." or "D:\\..." in file:// pages.
		if (/^[a-zA-Z]:[\\/]/.test(raw)) {
			const normalizedPath = raw.replace(/\\/g, '/').replace(/^\/+/, '');
			return new URL(`file:///${normalizedPath}`).href;
		}

		const absoluteUrl = new URL(raw, baseHref).href;
		const driveLikeUrlMatch = absoluteUrl.match(/^([a-zA-Z]):\/(.*)$/);
		if (driveLikeUrlMatch) {
			const drive = driveLikeUrlMatch[1].toUpperCase();
			return new URL(`file:///${drive}:/${driveLikeUrlMatch[2]}`).href;
		}

		return absoluteUrl;
	}

	function deriveFilenameParts(url) {
		if (String(url).startsWith('data:')) {
			return { path: 'data:', filename: 'image.png', basename: 'image', extension: 'png' };
		}

		try {
			const urlObj = new URL(String(url));
			const pathname = urlObj.pathname || '';
			const lastSlashIndex = pathname.lastIndexOf('/');
			const rawFilename = pathname.substring(lastSlashIndex + 1) || urlObj.hostname || 'image';
			const decodedFilename = decodeURIComponent(rawFilename);
			const extensionMatch = decodedFilename.match(/\.([a-z0-9]{1,8})$/i);
			const extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
			const basename = extension ? decodedFilename.slice(0, -(extension.length + 1)) : decodedFilename;
			const directoryPath = pathname.substring(0, Math.max(0, lastSlashIndex + 1));

			return {
				path: getUrlDirectoryBase(urlObj, directoryPath),
				filename: decodedFilename,
				basename: basename || decodedFilename || 'image',
				extension
			};
		} catch (error) {
			return { path: '', filename: 'image', basename: 'image', extension: '' };
		}
	}

	function getExtensionFromMimeType(mimeType) {
		const normalized = String(mimeType || '').toLowerCase();
		const map = {
			'image/jpeg': 'jpg',
			'image/jpg': 'jpg',
			'image/png': 'png',
			'image/gif': 'gif',
			'image/webp': 'webp',
			'image/avif': 'avif',
			'image/svg+xml': 'svg',
			'image/bmp': 'bmp',
			'image/x-icon': 'ico'
		};
		return map[normalized] || '';
	}

	function sanitizePathSegment(segment) {
		const cleaned = String(segment || '')
			.replace(/[<>:"|?*\u0000-\u001F]/g, '_')
			.replace(/\s+/g, ' ')
			.trim();
		if (!cleaned) return '';
		if (cleaned === '.' || cleaned === '..') return '_';
		return cleaned;
	}

	function normalizeRelativePath(pathText) {
		const normalized = String(pathText || '').replace(/\\/g, '/');
		return normalized
			.split('/')
			.map(sanitizePathSegment)
			.filter(Boolean)
			.join('/');
	}

	function escapeRegexText(str) {
		return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	function setSelectionToElementContents(element) {
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	let updateBadgeWithFilters = () => { }; // Placeholder at a higher scope

	function handleMutations(mutations, observer) {
		if (DEBUG) console.log(mutations);
		let needsUpdate = false;
		for (const mutation of mutations) {
			if (mutation.type === 'childList') {
				// If nodes were added or removed, a re-scan is likely needed.
				needsUpdate = true;
				break;
			} else if (mutation.type === 'attributes') {
				const attr = mutation.attributeName;
				if (attr === 'src' || attr === 'srcset' || attr === 'href') {
					// Direct image source change, definitely needs an update.
					needsUpdate = true;
					break;
				} else if (attr === 'style') {
					// For style changes, check if background-image related properties have changed.
					const oldStyle = mutation.oldValue || '';
					const newStyle = mutation.target.style.cssText;

					// A simple regex to extract the background-image value.
					const bgRegex = /background(?:-image)?\s*:[^;]+/;
					const oldBg = (oldStyle.match(bgRegex) || [''])[0];
					const newBg = (newStyle.match(bgRegex) || [''])[0];

					if (oldBg !== newBg) {
						needsUpdate = true;
						break;
					}
				}
			}
		}
		if (needsUpdate) updateBadgeWithFilters();
	}

	function setupPageObserver() {
		if (pageObserver) return; // Don't create multiple observers

		updateBadgeWithFilters = throttle(async () => {
			if (!hasRunFullScan && (!galleryHost || galleryHost.style.display === 'none')) {
				browser.runtime.sendMessage({ action: 'clearBadge' });
				return;
			}
			allScrapedUrls = scrapeImageUrls(); // Re-scrape

			const gridContainer = galleryHost?.shadowRoot?.querySelector('.ig-grid-container') || null;
			await filterAndDisplayImages(allScrapedUrls, gridContainer);
		}, 2000);

		pageObserver = new MutationObserver(handleMutations);
		pageObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['src', 'srcset', 'href', 'style'],
			attributeOldValue: true // Needed to compare old and new style values
		});

		if (!hasRunFullScan) {
			browser.runtime.sendMessage({ action: 'clearBadge' });
		} else {
			updateBadgeWithFilters();
		}
	}

	function cleanupPageObserver() {
		if (pageObserver) {
			pageObserver.disconnect();
			pageObserver = null;
		}
	}

	let currentPopupIndex = -1;
	let popup, popupContainer, popupImg, popupInfoBar;
	let currentPopupImgData = { url: '', naturalWidth: 0, naturalHeight: 0 };
	// State for popup image transformations (flip/rotate)
	let popupRotation = 0;
	let popupScaleX = 1;
	let popupScaleY = 1;

	let updateGridStyle = () => { }; // Placeholder at a higher scope

	function scrapeImageUrls() {
		const urlMap = new Map();

		// Centralized helper to normalize and add URLs
		const addUrl = (url, element, method) => {
			if (!url) {
				if (DEBUG) {
					debug_log_index++;
					debug_log += `${debug_log_index}\tscraper\t${method}\tfalse\tURL is null or empty\t${String(url).replace(/\t/g, '  ')}\t${getAncestorPath(element)}\n`;
				}
				return;
			}
			const trimmedUrl = url.trim();
			if (!trimmedUrl) {
				if (DEBUG) {
					debug_log_index++;
					debug_log += `${debug_log_index}\tscraper\t${method}\tfalse\tURL is empty after trimming\t${String(url).replace(/\t/g, '  ')}\t${getAncestorPath(element)}\n`;
				}
				return;
			}

			try {
				// The new URL() constructor correctly handles relative, absolute,
				// and protocol-relative ("//...") URLs when a base is provided.
					const absoluteUrl = resolveCandidateUrl(trimmedUrl, window.location.href);
				const cleanUrl = absoluteUrl.split('#')[0]; // Remove fragment
				if (urlMap.has(cleanUrl)) {
					if (DEBUG) {
						debug_log_index++;
						debug_log += `${debug_log_index}\tscraper\t${method}\tfalse\tDuplicate URL\t${cleanUrl.replace(/\t/g, '  ')}\t${getAncestorPath(element)}\n`;
					}
				} else {
					urlMap.set(cleanUrl, { url: cleanUrl, element });
					if (DEBUG) {
						debug_log_index++;
						debug_log += `${debug_log_index}\tscraper\t${method}\ttrue\tAdded URL\t${cleanUrl.replace(/\t/g, '  ')}\t${getAncestorPath(element)}\n`;
					}
				}
			} catch (e) {
				// Ignore invalid URLs
				if (DEBUG) {
					debug_log_index++;
					debug_log += `${debug_log_index}\tscraper\t${method}\tfalse\tInvalid URL format\t${trimmedUrl.replace(/\t/g, '  ')}\t${getAncestorPath(element)}\n`;
				}
			}
		};

		// Query all relevant elements in a single pass
		document.querySelectorAll("a, img, source, [style*='background']").forEach(el => {
			if (el.tagName === 'IMG') {
				addUrl(el.src, el, 'IMG.src');
				handleSrcset(el.srcset || el.dataset.srcset, el, 'IMG.srcset');
			} else if (el.tagName === 'SOURCE') {
				handleSrcset(el.srcset || el.dataset.srcset, el, 'SOURCE.srcset');
			} else if (el.tagName === 'A') {
				// Use getAttribute to get the raw value, which might be relative
				const href = el.getAttribute('href');
				if (href && /\.(jpg|jpeg|png|gif|webp|avif)($|\?|#)/i.test(href)) {
					addUrl(href, el, 'A.href');
				}
			} else if (el.style.backgroundImage) {
				const bgRegex = /url\(['"]?(.*?)['"]?\)/gi;
				let match;
				while ((match = bgRegex.exec(el.style.backgroundImage)) !== null) {
					if (match[1]) {
						addUrl(match[1], el, 'style.bg'); // Pass raw URL; addUrl will trim and resolve it
					}
				}
			}
		});

		function handleSrcset(srcset, element, method) {
			if (!srcset) return;

			const candidates = srcset.split(/,(?=\s+)/).map(s => s.trim()).filter(Boolean);
			if (candidates.length === 0) return;

			let largestW = { url: null, value: -1 };
			let largestX = { url: null, value: -1 };
			let noDescriptor = [];
			let unparsed = [];

			candidates.forEach(candidateStr => {
				const parts = candidateStr.split(/\s+/);
				const url = parts[0];
				const descriptor = parts[1];

				if (!descriptor) {
					noDescriptor.push(url);
					return;
				}

				const valueMatch = descriptor.match(/^(\d+(?:\.\d+)?)([wx])$/);
				if (valueMatch) {
					const value = parseFloat(valueMatch[1]);
					const type = valueMatch[2];

					if (type === 'w' && value > largestW.value) {
						largestW = { url, value };
					} else if (type === 'x' && value > largestX.value) {
						largestX = { url, value };
					}
				} else {
					unparsed.push(url);
				}
			});

			// Priority: w descriptor > x descriptor > no descriptor > unparsed
			if (largestW.url) {
				addUrl(largestW.url, element, method + ' (largest-w)');
			} else if (largestX.url) {
				addUrl(largestX.url, element, method + ' (largest-x)');
			} else if (noDescriptor.length > 0) {
				// Add all no-descriptor images (can't determine largest)
				noDescriptor.forEach(url => addUrl(url, element, method + ' (no-descriptor)'));
			} else if (unparsed.length > 0) {
				// Add all unparsed (can't determine largest)
				unparsed.forEach(url => addUrl(url, element, method + ' (unparsed)'));
			}
		}

		// NEW: Recursive function to scrape a document and its iframes
		function scrapeDocument(doc, depth = 0) {
			// Safety: limit recursion depth to prevent infinite loops
			if (depth > 10) return;

			try {
				// Scrape images in this document
				doc.querySelectorAll("a, img, source, [style*='background']").forEach(el => {
					if (el.tagName === 'IMG') {
						addUrl(el.src, el, `IMG.src[depth=${depth}]`);
						handleSrcset(el.srcset || el.dataset.srcset, el, `IMG.srcset[depth=${depth}]`);
					} else if (el.tagName === 'SOURCE') {
						handleSrcset(el.srcset || el.dataset.srcset, el, `SOURCE.srcset[depth=${depth}]`);
					} else if (el.tagName === 'A') {
						const href = el.getAttribute('href');
						if (href && /\.(jpg|jpeg|png|gif|webp|avif)($|\?|#)/i.test(href)) {
							addUrl(href, el, `A.href[depth=${depth}]`);
						}
					} else if (el.style.backgroundImage) {
						const bgRegex = /url\(['"]?(.*?)['"]?\)/gi;
						let match;
						while ((match = bgRegex.exec(el.style.backgroundImage)) !== null) {
							if (match[1]) {
								addUrl(match[1], el, `style.bg[depth=${depth}]`);
							}
						}
					}
				});

				// NEW: Recursively process iframes
				doc.querySelectorAll('iframe').forEach(iframe => {
					try {
						// Try to access iframe's contentDocument
						const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
						if (iframeDoc) {
							scrapeDocument(iframeDoc, depth + 1);
						}
					} catch (e) {
						// Cross-origin iframe - cannot access
						if (DEBUG) {
							console.log(`Cannot access iframe (cross-origin): ${iframe.src}`);
						}
					}
				});
			} catch (e) {
				if (DEBUG) {
					console.error(`Error scraping document at depth ${depth}:`, e);
				}
			}
		}

		// Start scraping from main document
		scrapeDocument(document);
		return Array.from(urlMap.values());
	}

	function revokeImageRecordResources(record) {
		if (record?.objectUrl) {
			URL.revokeObjectURL(record.objectUrl);
			record.objectUrl = '';
		}
		if (record?.element) {
			record.element.remove();
			record.element = null;
		}
	}

	function createImageRecord(urlData, overrides = {}) {
		const primaryUrl = overrides.sourceUrl || urlData.url;
		const filenameParts = deriveFilenameParts(primaryUrl);
		const discoveredSourceUrl = overrides.discoveredSourceUrl || urlData.url;
		return {
			recordKey: overrides.recordKey || `page:${primaryUrl}`,
			discoveryKind: overrides.discoveryKind || 'page',
			sourceUrl: primaryUrl,
			discoveredSourceUrl,
			derivedFromSourceUrl: overrides.derivedFromSourceUrl || '',
			derivedFromRecordKey: overrides.derivedFromRecordKey || '',
			probedOriginalUrl: '',
			probeAttempted: false,
			biggerExistsRecordKey: '',
			duplicateGroupKey: '',
			logIndex: null,
			galleryIndex: null,
			sourcePath: filenameParts.path || '',
			sourceFilename: filenameParts.filename || 'image',
			sourceBasename: filenameParts.basename || 'image',
			sourceExtension: filenameParts.extension || '',
			url: primaryUrl,
			sourceElement: urlData.element || null,
			domIndex: urlData.domIndex,
			element: null,
			width: 0,
			height: 0,
			pixels: 0,
			fileSize: 0,
			hash: '',
			alternateUrls: [urlData.url],
			path: filenameParts.path || '',
			filename: filenameParts.filename || 'image',
			basename: filenameParts.basename || 'image',
			extension: filenameParts.extension || '',
			fileType: filenameParts.extension || '',
			mimeType: '',
			blob: null,
			objectUrl: '',
			loadError: '',
			defaultFilterReasons: [],
			filterReasons: [],
			defaultInGallery: false,
			inGallery: false,
			isDerivedOriginal: overrides.discoveryKind === 'derived'
		};
	}

	function getPageRecordKey(url) {
		return `page:${url}`;
	}

	function getDerivedRecordKey(parentSourceUrl, derivedUrl) {
		return `derived:${parentSourceUrl}->${derivedUrl}`;
	}

	const ORIGINAL_FILENAME_RULES = [
		{
			id: 'underscore-width-w',
			match: (basename) => basename.match(/^(.*)_\d+w$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'dash-width-w',
			match: (basename) => basename.match(/^(.*)-\d+w$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'underscore-dimensions',
			match: (basename) => basename.match(/^(.*)_\d+x\d+$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'dash-dimensions',
			match: (basename) => basename.match(/^(.*)-\d+x\d+$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'underscore-height-p',
			match: (basename) => basename.match(/^(.*)_\d+p$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'dash-height-p',
			match: (basename) => basename.match(/^(.*)-\d+p$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'underscore-height',
			match: (basename) => basename.match(/^(.*)_\d+$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		},
		{
			id: 'dash-height',
			match: (basename) => basename.match(/^(.*)-\d+$/i),
			buildCandidates: (match, extension) => [`${match[1]}.${extension}`, `${match[1]}-original.${extension}`]
		}
	];

	function getFilenameOriginalGuessPlan(urlText) {
		if (String(urlText).startsWith('data:')) return null;

		try {
			const urlObj = new URL(String(urlText));
			const derived = deriveFilenameParts(urlObj.href);
			const extension = derived.extension || '';
			if (!extension) return null;
			const directory = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
			const directoryBase = getUrlDirectoryBase(urlObj, directory);

			for (const rule of ORIGINAL_FILENAME_RULES) {
				const match = rule.match(derived.basename || '');
				if (!match) continue;
				return {
					cacheKey: `${directoryBase}::${rule.id}::${String(match[1] || '').toLowerCase()}::${extension.toLowerCase()}`,
					urlObj,
					derived,
					directory,
					directoryBase,
					candidates: rule.buildCandidates(match, extension)
				};
			}
		} catch (error) {
			return null;
		}

		return null;
	}

	async function probeOriginalImageUrl(sourceUrl) {
		const plan = getFilenameOriginalGuessPlan(sourceUrl);
		if (!plan) return null;

		const cached = originalGuessCache.get(plan.cacheKey);
		if (cached) {
			if (cached.status === 'resolved' && cached.relativeFilename) {
				const resolvedUrl = new URL(cached.relativeFilename, plan.directoryBase).href;
				return {
					url: resolvedUrl,
					cacheKey: plan.cacheKey,
					relativeFilename: cached.relativeFilename
				};
			}
			return null;
		}

		for (const candidateFilename of plan.candidates) {
			try {
				const candidateUrl = new URL(candidateFilename, plan.directoryBase).href;
				const response = await fetch(candidateUrl, { method: 'HEAD', cache: 'force-cache' });
				const contentType = response.headers.get('content-type') || '';
				if (response.ok && contentType.startsWith('image/')) {
					originalGuessCache.set(plan.cacheKey, { status: 'resolved', relativeFilename: candidateFilename });
					return {
						url: candidateUrl,
						cacheKey: plan.cacheKey,
						relativeFilename: candidateFilename
					};
				}
			} catch (error) {
				// Ignore probe failures and continue through the candidate list.
			}
		}

		originalGuessCache.set(plan.cacheKey, { status: 'miss' });
		return null;
	}

	function applyResolvedUrlToRecord(record, url) {
		const resolvedParts = deriveFilenameParts(url);
		record.url = url;
		record.path = resolvedParts.path || record.sourcePath || '';
		record.filename = resolvedParts.filename || record.sourceFilename || 'image';
		record.basename = resolvedParts.basename || record.sourceBasename || record.filename || 'image';
		record.extension = resolvedParts.extension || record.sourceExtension || '';
		record.fileType = record.extension || '';
		record.isDerivedOriginal = record.discoveryKind === 'derived';
	}

	async function processImageRecord(record) {
		try {
			record.probedOriginalUrl = '';
			record.isDerivedOriginal = record.discoveryKind === 'derived';
			applyResolvedUrlToRecord(record, record.sourceUrl);

			if (settings.deriveOriginals !== false && record.discoveryKind === 'page') {
				record.probeAttempted = true;
				const originalProbe = await probeOriginalImageUrl(record.sourceUrl);
				if (originalProbe?.url && originalProbe.url !== record.sourceUrl) {
					record.probedOriginalUrl = originalProbe.url;
				}
			} else if (record.discoveryKind === 'page') {
				record.probeAttempted = false;
			}

			const response = await fetch(record.sourceUrl, { cache: 'force-cache' });
			if (!response.ok) throw new Error(`Fetch failed (${response.status})`);

			const blob = await response.blob();
			if (blob.size === 0) throw new Error('Empty blob');

			const bitmap = await createImageBitmap(blob);
			record.width = bitmap.width;
			record.height = bitmap.height;
			record.pixels = bitmap.width * bitmap.height;
			record.fileSize = blob.size;
			record.mimeType = blob.type || '';
			record.fileType = getExtensionFromMimeType(blob.type) || record.extension || '';
			record.extension = record.fileType || record.extension || 'png';
			record.blob = blob;
			record.loadError = '';
			bitmap.close();

			if (record.objectUrl) {
				URL.revokeObjectURL(record.objectUrl);
			}
			record.objectUrl = URL.createObjectURL(blob);

			const buffer = await blob.arrayBuffer();
			const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
			record.hash = Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
		} catch (error) {
			record.isDerivedOriginal = record.discoveryKind === 'derived';
			applyResolvedUrlToRecord(record, record.sourceUrl);
			record.loadError = error instanceof Error ? error.message : String(error);
			record.blob = null;
			record.mimeType = '';
			record.hash = '';
			record.width = 0;
			record.height = 0;
			record.pixels = 0;
			record.fileSize = 0;
			record.fileType = record.sourceExtension || '';
			record.extension = record.sourceExtension || '';
			if (record.objectUrl) {
				URL.revokeObjectURL(record.objectUrl);
				record.objectUrl = '';
			}
		}
	}

	async function processImagesConcurrently(recordsToProcess, onProgress) {
		const totalToProcess = recordsToProcess.length;
		const loadingNotifier = galleryHost.shadowRoot.getElementById('ig-loading-notifier');
		const loadingText = loadingNotifier.querySelector('span');
		let processedCount = 0;

		const updateNotifier = () => {
			loadingNotifier.style.display = 'block';
			loadingNotifier.style.opacity = '1';
			loadingText.textContent = `Loading... ${processedCount} of ${totalToProcess}`;
		};

		if (totalToProcess === 0) {
			loadingNotifier.style.opacity = '0';
			loadingNotifier.style.display = 'none';
			return;
		}

		updateNotifier();

		const queue = [...recordsToProcess];
		const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, queue.length) }, async () => {
			while (queue.length > 0) {
				const record = queue.shift();
				await processImageRecord(record);
				processedCount++;
				updateNotifier();
				onProgress?.(record);
			}
		});

		await Promise.all(workers);

		setTimeout(() => {
			loadingNotifier.style.opacity = '0';
			setTimeout(() => {
				loadingNotifier.style.display = 'none';
			}, 1000);
		}, 1000);
	}

	function compileFilterRegexes() {
		let includeRegex = null;
		let excludeRegex = null;
		let includeError = '';
		let excludeError = '';

		if (settings.includeRegex) {
			try {
				includeRegex = new RegExp(settings.includeRegex, 'i');
			} catch (error) {
				includeError = error instanceof Error ? error.message : String(error);
			}
		}

		if (settings.excludeRegex) {
			try {
				excludeRegex = new RegExp(settings.excludeRegex, 'i');
			} catch (error) {
				excludeError = error instanceof Error ? error.message : String(error);
			}
		}

		return { includeRegex, excludeRegex, includeError, excludeError };
	}

	function getFilterReasons(record, compiledRegexes) {
		const reasons = [];

		if (compiledRegexes.includeRegex && !compiledRegexes.includeRegex.test(record.url)) reasons.push('include');
		if (compiledRegexes.excludeRegex && compiledRegexes.excludeRegex.test(record.url)) reasons.push('exclude');
		if (!record.loadError && record.width < settings.minWidth) reasons.push('width');
		if (!record.loadError && record.height < settings.minHeight) reasons.push('height');

		return reasons;
	}

	function getGallerySortComparator(sortBy = settings.sortBy || 'dom') {
		if (sortBy === 'path') {
			return (a, b) => a.path.localeCompare(b.path) || a.filename.localeCompare(b.filename) || a.domIndex - b.domIndex;
		}
		if (sortBy === 'filename') {
			return (a, b) => a.filename.localeCompare(b.filename) || a.path.localeCompare(b.path) || a.domIndex - b.domIndex;
		}
		if (sortBy === 'pixels') {
			return (a, b) => b.pixels - a.pixels || a.domIndex - b.domIndex || a.filename.localeCompare(b.filename);
		}
		return (a, b) => a.domIndex - b.domIndex || a.filename.localeCompare(b.filename);
	}

	function getRecordsInGalleryOrder() {
		return [...allDiscoveredImages].sort(getGallerySortComparator());
	}

	function getDerivedLogState(record, pageSourceUrls) {
		return record.discoveryKind === 'derived' && !pageSourceUrls.has(record.sourceUrl);
	}

	function getLogFilterState(record, pageSourceUrls) {
		if (record.loadError) {
			return {
				className: 'error',
				sortValue: 'error',
				text: 'error',
				title: record.loadError,
				highlightState: null
			};
		}

		if (record.inGallery) {
			if (record.defaultFilterReasons.length > 0) {
				return {
					className: 'forced-visible',
					sortValue: record.defaultFilterReasons.join(', '),
					text: escapeHtml(record.defaultFilterReasons.join(', ')),
					title: '',
					highlightState: null
				};
			}
			if (getDerivedLogState(record, pageSourceUrls)) {
				const sourceRecord = getRecordByKey(record.derivedFromRecordKey);
				return {
					className: 'derived',
					sortValue: 'derived',
					text: '&#10003; <span class="ig-log-activator">derived</span>',
					title: sourceRecord?.sourceFilename || '',
					highlightState: sourceRecord ? {
						type: 'derived',
						value: sourceRecord.recordKey,
						sourceKey: `derived:${record.recordKey}`
					} : null
				};
			}
			return {
				className: 'ok',
				sortValue: '',
				text: '&#10003;',
				title: '',
				highlightState: null
			};
		}

		if (record.filterReasons.length > 0) {
			const isDuplicate = record.filterReasons.length === 1 && record.filterReasons[0] === 'duplicate' && record.duplicateGroupKey;
			return {
				className: 'filtered',
				sortValue: record.filterReasons.join(', '),
				text: isDuplicate ? '<span class="ig-log-activator">duplicate</span>' : escapeHtml(record.filterReasons.join(', ')),
				title: '',
				highlightState: isDuplicate ? {
					type: 'duplicate',
					value: record.duplicateGroupKey,
					sourceKey: `duplicate:${record.recordKey}`
				} : null
			};
		}

		return {
			className: 'filtered',
			sortValue: '',
			text: '',
			title: '',
			highlightState: null
		};
	}

	function ensureGridElement(record) {
		if (record.element) return record.element;

		const imgWrapper = document.createElement('div');
		imgWrapper.className = 'ig-img-wrapper';

		const imgEl = document.createElement('img');
		const infoDiv = document.createElement('div');
		infoDiv.className = 'ig-img-info';

		imgWrapper.appendChild(imgEl);
		imgWrapper.appendChild(infoDiv);

		imgEl.addEventListener('click', (event) => {
			if (event.button !== 0) return;
			event.stopPropagation();
			showImagePopup(allImageData.findIndex((item) => item.recordKey === record.recordKey));
		});

		imgWrapper.addEventListener('mouseenter', () => {
			currentlyHoveredImgWrapper = imgWrapper;
		});
		imgWrapper.addEventListener('mouseleave', () => {
			if (currentlyHoveredImgWrapper === imgWrapper) currentlyHoveredImgWrapper = null;
		});

		record.element = imgWrapper;
		return imgWrapper;
	}

	function buildGalleryImageList() {
		const compiledRegexes = compileFilterRegexes();
		const orderedRecords = getRecordsInGalleryOrder();
		const galleryImages = [];
		const galleryHashMasters = new Map();
		const recordsBySourceUrl = new Map();
		const baseReasonsByKey = new Map();

		orderedRecords.forEach((record, index) => {
			record.alternateUrls = [record.url];
			record.defaultFilterReasons = [];
			record.filterReasons = [];
			record.defaultInGallery = false;
			record.inGallery = false;
			record.galleryIndex = null;
			record.logIndex = index + 1;
			record.biggerExistsRecordKey = '';
			record.duplicateGroupKey = record.hash || '';
			recordsBySourceUrl.set(record.sourceUrl, record);
			baseReasonsByKey.set(record.recordKey, getFilterReasons(record, compiledRegexes));
		});

		orderedRecords.forEach((record) => {
			if (record.discoveryKind !== 'page' || !record.probedOriginalUrl || record.loadError) return;
			const targetRecord = recordsBySourceUrl.get(record.probedOriginalUrl);
			if (!targetRecord || targetRecord.recordKey === record.recordKey || targetRecord.loadError) return;
			if ((baseReasonsByKey.get(targetRecord.recordKey) || []).length > 0) return;
			const sourcePixels = record.pixels || 0;
			const targetPixels = targetRecord.pixels || 0;
			if (targetPixels > sourcePixels || targetRecord.width > record.width || targetRecord.height > record.height) {
				record.biggerExistsRecordKey = targetRecord.recordKey;
			}
		});

		orderedRecords.forEach((record) => {
			let reasons = [...(baseReasonsByKey.get(record.recordKey) || [])];
			if (!record.loadError && record.biggerExistsRecordKey) {
				reasons = reasons.filter((reason) => reason !== 'width' && reason !== 'height');
				reasons.push('bigger exists');
			}
			record.defaultFilterReasons = reasons;

			if (!record.loadError && record.defaultFilterReasons.length === 0 && record.hash) {
				const existingMaster = galleryHashMasters.get(record.hash);
				if (existingMaster) {
					record.defaultFilterReasons = ['duplicate'];
					record.duplicateGroupKey = record.hash;
					existingMaster.alternateUrls.push(record.url);
				} else {
					galleryHashMasters.set(record.hash, record);
				}
			}

			record.defaultInGallery = !record.loadError && record.defaultFilterReasons.length === 0;

			const manualOverride = manualVisibilityOverrides.get(record.recordKey);
			if (record.loadError) {
				record.inGallery = false;
				record.filterReasons = [...record.defaultFilterReasons];
			} else if (manualOverride === 'hide') {
				record.inGallery = false;
				record.filterReasons = ['hidden'];
			} else if (manualOverride === 'show') {
				record.inGallery = true;
				record.filterReasons = [...record.defaultFilterReasons];
			} else {
				record.inGallery = record.defaultInGallery;
				record.filterReasons = [...record.defaultFilterReasons];
			}
			if (record.inGallery) galleryImages.push(record);
		});

		galleryImages.forEach((record, index) => {
			record.galleryIndex = index + 1;
		});

		return galleryImages;
	}

	async function syncImageRecords(urlObjects, onProgress) {
		const deduplicated = urlObjects
			.map((urlObject, index) => ({ ...urlObject, domIndex: index }))
			.filter((urlObject, index, list) => list.findIndex((candidate) => candidate.url === urlObject.url) === index);

		const nextKeys = new Set();
		const pageUrls = new Set(deduplicated.map((record) => record.url));
		const recordsToProcess = [];
		const pageRecords = deduplicated.map((urlData) => {
			const recordKey = getPageRecordKey(urlData.url);
			nextKeys.add(recordKey);
			const existing = imageRecordsByKey.get(recordKey);
			if (existing) {
				existing.domIndex = urlData.domIndex;
				existing.sourceElement = urlData.element || null;
				existing.sourceUrl = urlData.url;
				existing.discoveredSourceUrl = urlData.url;
				existing.recordKey = recordKey;
				existing.discoveryKind = 'page';
				existing.derivedFromSourceUrl = '';
				existing.derivedFromRecordKey = '';
				if (settings.deriveOriginals !== false && !existing.probeAttempted) {
					recordsToProcess.push(existing);
				}
				return existing;
			}

			const record = createImageRecord(urlData, { recordKey, discoveryKind: 'page' });
			imageRecordsByKey.set(record.recordKey, record);
			recordsToProcess.push(record);
			return record;
		});

		allDiscoveredImages = [...pageRecords];
		onProgress?.();
		await processImagesConcurrently(recordsToProcess, onProgress);

		const derivedRecords = [];
		const derivedToProcess = [];
		if (settings.deriveOriginals !== false) {
			pageRecords.forEach((pageRecord) => {
				if (!pageRecord.probedOriginalUrl || pageRecord.probedOriginalUrl === pageRecord.sourceUrl) return;
				if (pageUrls.has(pageRecord.probedOriginalUrl)) return;

				const recordKey = getDerivedRecordKey(pageRecord.sourceUrl, pageRecord.probedOriginalUrl);
				nextKeys.add(recordKey);
				const existing = imageRecordsByKey.get(recordKey);
				if (existing) {
					existing.domIndex = pageRecord.domIndex;
					existing.sourceElement = pageRecord.sourceElement;
					existing.sourceUrl = pageRecord.probedOriginalUrl;
					existing.discoveredSourceUrl = pageRecord.sourceUrl;
					existing.recordKey = recordKey;
					existing.discoveryKind = 'derived';
					existing.derivedFromSourceUrl = pageRecord.sourceUrl;
					existing.derivedFromRecordKey = pageRecord.recordKey;
					derivedRecords.push(existing);
					return;
				}

				const derivedRecord = createImageRecord({
					url: pageRecord.probedOriginalUrl,
					element: pageRecord.sourceElement,
					domIndex: pageRecord.domIndex
				}, {
					recordKey,
					discoveryKind: 'derived',
					sourceUrl: pageRecord.probedOriginalUrl,
					discoveredSourceUrl: pageRecord.sourceUrl,
					derivedFromSourceUrl: pageRecord.sourceUrl,
					derivedFromRecordKey: pageRecord.recordKey
				});
				imageRecordsByKey.set(recordKey, derivedRecord);
				derivedRecords.push(derivedRecord);
				derivedToProcess.push(derivedRecord);
			});
		}

		for (const [recordKey, record] of imageRecordsByKey.entries()) {
			if (!nextKeys.has(recordKey)) {
				revokeImageRecordResources(record);
				imageRecordsByKey.delete(recordKey);
			}
		}

		allDiscoveredImages = [...pageRecords, ...derivedRecords];
		onProgress?.();
		await processImagesConcurrently(derivedToProcess, onProgress);
		allDiscoveredImages = [...pageRecords, ...derivedRecords];
	}

	function renderGallery(container) {
		container.innerHTML = '';
		allImageData.forEach((record) => {
			const element = ensureGridElement(record);
			element.querySelector('img').src = record.objectUrl || record.url;
			updateInfoDiv(record, element.querySelector('.ig-img-info'));
			container.appendChild(element);
		});
	}

	function renderEmptyGallery(container) {
		container.innerHTML = '<div class="ig-no-images">No images found matching your criteria.</div>';
	}

	async function filterAndDisplayImages(urlObjects, container) {
		const renderCurrentState = (renderUi = true) => {
			allImageData = buildGalleryImageList();
			if (renderUi && container) {
				if (allImageData.length === 0) {
					renderEmptyGallery(container);
				} else {
					renderGallery(container);
				}
				updateGridStyle();
				if (galleryHost?.shadowRoot) renderLogTable();
				if (galleryHost?.shadowRoot) updateSaveDialogState();
			}

			browser.runtime.sendMessage({ action: 'updateBadge', count: allImageData.length });
		};
		const shouldRenderUi = Boolean(container && galleryHost?.style.display !== 'none');
		renderCurrentState(shouldRenderUi);
		await syncImageRecords(urlObjects, () => renderCurrentState(shouldRenderUi));
		renderCurrentState(shouldRenderUi);
	}

	function updateInfoDiv(imgData, infoDiv) {
		let infoHtml = '';
		const duplicateCount = imgData.alternateUrls.length;
		const filename = imgData.filename || 'image';
		const path = imgData.path || '';
		const galleryIndex = imgData.galleryIndex ? `#${imgData.galleryIndex}` : '';
		let paramsHtml = '';

		if (!String(imgData.url).startsWith('data:')) {
			try {
				const urlObj = new URL(String(imgData.url));
				const params = urlObj.search ? urlObj.search.substring(1).split('&').map(p => p.split('=')).sort((a, b) => a[0].localeCompare(b[0])) : [];
				paramsHtml = params.map(p => `<div class="ig-grid-infobar-param"><b>${decodeURIComponent(p[0])} </b> ${decodeURIComponent(p[1] || '')}</div>`).join('');
			} catch (e) {
				// Keep derived filename/path fallback.
			}
		}

		const duplicateIndicator = duplicateCount > 1 ? `<span class="ig-duplicate-count" title="${imgData.alternateUrls.join('\n')}">(${duplicateCount})</span>` : '';

		infoHtml = `
			${paramsHtml ? `<div class="ig-grid-infobar-params">${paramsHtml}</div>` : ''}
			${(galleryIndex || path) ? `
				<div class="ig-grid-infobar-path-row">
					${galleryIndex ? `<div class="ig-grid-infobar-index">${galleryIndex}</div>` : '<div class="ig-grid-infobar-index"></div>'}
					${path ? `<div class="ig-grid-infobar-path">${path}</div>` : '<div class="ig-grid-infobar-path"></div>'}
				</div>
			` : ''}
			<div class="ig-grid-infobar-details">
				<span class="ig-grid-infobar-dimensions">${imgData.width > 0 ? `${imgData.width}x${imgData.height}` : ''}</span>
				<span class="ig-grid-infobar-filename">
					${filename}
					${duplicateIndicator}
				</span>
			</div>`;

		infoDiv.innerHTML = infoHtml;

		if (duplicateCount > 1) {
			const dupIndicator = infoDiv.querySelector('.ig-duplicate-count');
			const tooltip = document.createElement('div');
			tooltip.className = 'ig-duplicate-tooltip';
			tooltip.textContent = imgData.alternateUrls.join('\n');
			dupIndicator.appendChild(tooltip);
		}
	}

	function getRecordFilenameWithExtension(record) {
		const extension = record.extension || record.fileType || 'png';
		if (/\.[a-z0-9]{1,8}$/i.test(record.filename || '')) {
			return record.filename;
		}
		return `${record.basename || record.filename || 'image'}.${extension}`;
	}

	function getSaveDialogElements() {
		if (!galleryHost?.shadowRoot) return {};
		return {
			backdrop: galleryHost.shadowRoot.getElementById('ig-save-dialog-backdrop'),
			input: galleryHost.shadowRoot.getElementById('ig-save-name'),
			error: galleryHost.shadowRoot.getElementById('ig-save-error'),
			list: galleryHost.shadowRoot.getElementById('ig-save-list'),
			saveAllBtn: galleryHost.shadowRoot.getElementById('ig-save-all-btn'),
			saveExploreBtn: galleryHost.shadowRoot.getElementById('ig-save-explore-btn'),
			saveViewBtn: galleryHost.shadowRoot.getElementById('ig-save-view-btn')
		};
	}

	function getRelativeSaveName(record, rawValue, index) {
		const trimmed = String(rawValue || '').trim();
		const useOriginalNames = trimmed === '' || /[\\/]\s*$/.test(trimmed);
		const folderPrefix = useOriginalNames ? normalizeRelativePath(trimmed) : '';
		const extension = record.extension || record.fileType || 'png';
		if (useOriginalNames) {
			return normalizeRelativePath([folderPrefix, getRecordFilenameWithExtension(record)].filter(Boolean).join('/'));
		}
		const basePath = normalizeRelativePath(trimmed);
		const parts = basePath.split('/').filter(Boolean);
		const baseName = sanitizePathSegment(parts.pop() || record.basename || 'image');
		const directory = parts.join('/');
		const serial = String(index + 1).padStart(3, '0');
		return normalizeRelativePath([directory, `${baseName} ${serial}.${extension}`].filter(Boolean).join('/'));
	}

	function getOriginalSaveList() {
		return allImageData.map((record) => getRecordFilenameWithExtension(record));
	}

	function isSaveDialogOpen() {
		const { backdrop } = getSaveDialogElements();
		return Boolean(backdrop && backdrop.style.display === 'flex');
	}

	async function refreshSaveCollisionState(plannedPaths, queryKey) {
		const requestId = ++saveCollisionRequestId;
		try {
			const response = await browser.runtime.sendMessage({
				action: 'checkSaveCollisions',
				files: plannedPaths
			});
			if (requestId !== saveCollisionRequestId || saveCollisionQueryKey !== queryKey) return;
			saveCollisionPaths = new Set(response?.collisions || []);
		} catch (error) {
			if (requestId !== saveCollisionRequestId || saveCollisionQueryKey !== queryKey) return;
			saveCollisionPaths = new Set();
		}
		updateSaveDialogState();
	}

	function updateSaveDialogState() {
		const { input, error, list, saveAllBtn, saveExploreBtn, saveViewBtn } = getSaveDialogElements();
		if (!input || !error || !list) return;

		const rawValue = input.value.trim();
		const originalNames = getOriginalSaveList();
		const counts = new Map();
		originalNames.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
		const hasDuplicates = originalNames.some((name) => counts.get(name) > 1);
		const plannedNames = allImageData.map((record, index) => getRelativeSaveName(record, rawValue, index));
		const plannedCounts = new Map();
		plannedNames.forEach((name) => plannedCounts.set(name, (plannedCounts.get(name) || 0) + 1));
		const hasPlannedDuplicates = plannedNames.some((name) => plannedCounts.get(name) > 1);
		const queryKey = plannedNames.join('\n');
		if (saveCollisionQueryKey !== queryKey) {
			saveCollisionQueryKey = queryKey;
			saveCollisionPaths = new Set();
			void refreshSaveCollisionState(plannedNames, queryKey);
		}
		const hasExistingCollisions = plannedNames.some((name) => saveCollisionPaths.has(name));

		const firstImage = allImageData[0];
		input.placeholder = firstImage ? (firstImage.basename || 'image') : '';
		error.textContent = activeSaveError || (hasExistingCollisions ? 'Existing destination collisions are highlighted in red.' : '');

		list.innerHTML = originalNames.length > 0
			? originalNames.map((name, index) => {
				const nextName = plannedNames[index] || '';
				const duplicateClass = counts.get(name) > 1 || plannedCounts.get(nextName) > 1 || saveCollisionPaths.has(nextName) ? 'duplicate' : '';
				const mapped = rawValue ? `${escapeHtml(name)} &rarr; ${escapeHtml(nextName)}` : escapeHtml(name);
				return `<li class="${duplicateClass}">${mapped}</li>`;
			}).join('')
			: '<li class="empty">No images are currently in the gallery.</li>';

		const disableSave = hasDuplicates || hasPlannedDuplicates || hasExistingCollisions || originalNames.length === 0;
		saveAllBtn.disabled = disableSave;
		saveExploreBtn.disabled = disableSave;
		saveViewBtn.disabled = disableSave;
	}

	function openSaveDialog() {
		const { backdrop, input } = getSaveDialogElements();
		if (!backdrop || !input) return;
		activeSaveError = '';
		saveCollisionQueryKey = '';
		saveCollisionPaths = new Set();
		saveInputAutofillArmed = true;
		input.value = '';
		updateSaveDialogState();
		backdrop.style.display = 'flex';
		input.focus();
		syncHeaderToggleState();
	}

	function closeSaveDialog() {
		const { backdrop, error } = getSaveDialogElements();
		if (!backdrop || !error) return;
		backdrop.style.display = 'none';
		activeSaveError = '';
		saveCollisionQueryKey = '';
		saveCollisionPaths = new Set();
		error.textContent = '';
		saveInputAutofillArmed = false;
		syncHeaderToggleState();
	}

	function buildSavePlan() {
		const { input } = getSaveDialogElements();
		if (!input) {
			return { files: [], error: 'The save dialog is not available.' };
		}

		const rawValue = input.value.trim();
		const originalNames = getOriginalSaveList();
		const duplicateNames = originalNames.filter((name, index) => originalNames.indexOf(name) !== index);
		if (duplicateNames.length > 0) {
			return { files: [], error: 'Duplicate original filenames must be resolved before saving.' };
		}

		const files = allImageData.map((record, index) => {
			if (!record.blob) {
				throw new Error(`"${record.filename}" is not available to save.`);
			}
			const relativePath = getRelativeSaveName(record, rawValue, index);

			return {
				relativePath,
				blob: record.blob
			};
		});
		const plannedCounts = new Map();
		files.forEach((file) => plannedCounts.set(file.relativePath, (plannedCounts.get(file.relativePath) || 0) + 1));
		const duplicatePlannedPaths = [...plannedCounts.entries()].filter((entry) => entry[1] > 1).map((entry) => entry[0]);
		if (duplicatePlannedPaths.length > 0) {
			return { files: [], error: `Duplicate destination filenames must be resolved before saving: ${duplicatePlannedPaths.join(', ')}` };
		}

		return { files, error: '' };
	}

	async function saveImages(postAction) {
		try {
			const { files, error } = buildSavePlan();
			if (error) throw new Error(error);

			const collisionCheck = await browser.runtime.sendMessage({
				action: 'checkSaveCollisions',
				files: files.map((file) => file.relativePath)
			});
			if (collisionCheck?.collisions?.length) {
				throw new Error(`Nothing was saved because these files already exist: ${collisionCheck.collisions.join(', ')}`);
			}

			await browser.runtime.sendMessage({
				action: 'saveImages',
				files,
				postAction
			});
			closeSaveDialog();
		} catch (error) {
			activeSaveError = error instanceof Error ? error.message : String(error);
			updateSaveDialogState();
		}
	}

	function getRecordByKey(recordKey) {
		return allDiscoveredImages.find((record) => record.recordKey === recordKey) || null;
	}

	function getFilenameStem(record) {
		return String(record.basename || record.filename || '').toLowerCase();
	}

	function setLogHighlightState(nextState) {
		if (nextState && logHighlightState?.sourceKey === nextState.sourceKey) {
			logHighlightState = null;
		} else {
			logHighlightState = nextState;
		}
		renderLogTable();
	}

	function isLogFilterCellActive(record, filterState) {
		return Boolean(filterState.highlightState && logHighlightState?.sourceKey === filterState.highlightState.sourceKey);
	}

	function isLogCellHighlighted(record, cellType) {
		if (!logHighlightState) return false;
		if (cellType === 'path') return logHighlightState.type === 'path' && logHighlightState.value === (record.path || '');
		if (cellType === 'fileType') return logHighlightState.type === 'fileType' && logHighlightState.value === (record.fileType || '');
		if (cellType === 'width') return logHighlightState.type === 'width' && logHighlightState.value === String(record.width || '');
		if (cellType === 'height') return logHighlightState.type === 'height' && logHighlightState.value === String(record.height || '');
		if (cellType === 'filename') {
			if (logHighlightState.type === 'filenameStem') return logHighlightState.value === getFilenameStem(record);
			if (logHighlightState.type === 'derived') return logHighlightState.value === record.recordKey;
			if (logHighlightState.type === 'duplicate') return Boolean(record.duplicateGroupKey) && logHighlightState.value === record.duplicateGroupKey;
		}
		return false;
	}

	function getLogSortValue(record, column, pageSourceUrls) {
		if (column === 'galleryIndex') return record.logIndex || Number.MAX_SAFE_INTEGER;
		if (column === 'hidden') return record.inGallery ? 0 : 1;
		if (column === 'path') return record.path || '';
		if (column === 'filename') return record.filename || '';
		if (column === 'fileType') return record.fileType || '';
		if (column === 'width') return record.width || 0;
		if (column === 'height') return record.height || 0;
		if (column === 'filter') return getLogFilterState(record, pageSourceUrls).sortValue;
		return record.domIndex;
	}

	function renderLogTable() {
		if (!galleryHost?.shadowRoot) return;

		const logBody = galleryHost.shadowRoot.getElementById('ig-log-body');
		const logButton = galleryHost.shadowRoot.getElementById('logBtn');
		if (!logBody || !logButton) return;
		const pageSourceUrls = new Set(allDiscoveredImages.filter((record) => record.discoveryKind === 'page').map((record) => record.sourceUrl));

		const rows = [...allDiscoveredImages].sort((a, b) => {
			const aValue = getLogSortValue(a, logSortState.column, pageSourceUrls);
			const bValue = getLogSortValue(b, logSortState.column, pageSourceUrls);
			let comparison = 0;

			if (typeof aValue === 'number' && typeof bValue === 'number') {
				comparison = aValue - bValue;
			} else {
				comparison = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' });
			}

			if (comparison === 0) comparison = a.domIndex - b.domIndex;
			return logSortState.direction === 'asc' ? comparison : -comparison;
		});

		logBody.innerHTML = rows.map((record) => {
			const galleryIndex = record.logIndex || '';
			const filterState = getLogFilterState(record, pageSourceUrls);
			const filterTitle = filterState.title ? ` title="${escapeHtml(filterState.title)}"` : '';
			const pathHighlightClass = isLogCellHighlighted(record, 'path') ? ' ig-log-highlighted' : '';
			const filenameHighlightClass = isLogCellHighlighted(record, 'filename') ? ' ig-log-highlighted' : '';
			const typeHighlightClass = isLogCellHighlighted(record, 'fileType') ? ' ig-log-highlighted' : '';
			const widthHighlightClass = isLogCellHighlighted(record, 'width') ? ' ig-log-highlighted' : '';
			const heightHighlightClass = isLogCellHighlighted(record, 'height') ? ' ig-log-highlighted' : '';
			const filterActiveClass = isLogFilterCellActive(record, filterState) ? ' ig-log-cell-active' : '';
			const hiddenSelectedClass = record.inGallery ? '' : ' selected';
			const hiddenDisabledAttr = record.loadError ? ' disabled' : '';
			const hiddenTitle = record.inGallery ? 'Hide this image from the gallery' : 'Show this image in the gallery';
			const thumbSrc = record.objectUrl || record.url;
			const thumbCell = record.loadError
				? '<span class="ig-log-thumb-missing">-</span>'
				: `<img class="ig-log-thumb ig-log-thumb-clickable" src="${escapeHtml(thumbSrc)}" alt="" title="Open image">`;
			return `
				<tr data-record-key="${escapeHtml(record.recordKey)}">
					<td class="numeric">${galleryIndex}</td>
					<td class="thumbnail">${thumbCell}</td>
					<td class="ig-log-matchable${pathHighlightClass}" data-highlight-type="path" data-highlight-value="${escapeHtml(record.path || '')}">${escapeHtml(record.path || '')}</td>
					<td class="ig-log-matchable${filenameHighlightClass}" data-highlight-type="filenameStem" data-highlight-value="${escapeHtml(getFilenameStem(record))}">${escapeHtml(record.filename || '')}</td>
					<td class="ig-log-matchable${typeHighlightClass}" data-highlight-type="fileType" data-highlight-value="${escapeHtml(record.fileType || '')}">${escapeHtml(record.fileType || '')}</td>
					<td class="numeric ig-log-matchable${widthHighlightClass}" data-highlight-type="width" data-highlight-value="${escapeHtml(String(record.width || ''))}">${record.width || ''}</td>
					<td class="numeric ig-log-matchable${heightHighlightClass}" data-highlight-type="height" data-highlight-value="${escapeHtml(String(record.height || ''))}">${record.height || ''}</td>
					<td class="hidden"><button class="ig-log-hidden-toggle${hiddenSelectedClass}" data-action="toggle-hidden"${hiddenDisabledAttr} title="${hiddenTitle}">X</button></td>
					<td class="filter ${filterState.className}${filterActiveClass}"${filterTitle}${filterState.highlightState ? ` data-highlight-type="${escapeHtml(filterState.highlightState.type)}" data-highlight-value="${escapeHtml(filterState.highlightState.value)}" data-highlight-source="${escapeHtml(filterState.highlightState.sourceKey)}"` : ''}>${filterState.text}</td>
				</tr>
			`;
		}).join('');
	}

	function getDefaultProfileFallback() {
		return {
			gridCols: 5,
			gridRows: 4,
			minWidth: 50,
			minHeight: 50,
			sortBy: 'dom',
			deriveOriginals: true,
			includeRegex: '',
			excludeRegex: ''
		};
	}

	function normalizeStoredProfileSettings(profileSettings) {
		const normalized = { ...getDefaultProfileFallback(), ...(profileSettings || {}) };
		if (normalized.gridImgWidth || normalized.gridImgHeight) {
			normalized.gridCols = normalized.gridImgWidth > 20 ? Math.round(1200 / normalized.gridImgWidth) : 5;
			normalized.gridRows = normalized.gridImgHeight > 20 ? Math.round(800 / normalized.gridImgHeight) : 4;
			delete normalized.gridImgWidth;
			delete normalized.gridImgHeight;
		}
		if (normalized.minHeight === undefined) normalized.minHeight = normalized.minWidth;
		if (normalized.minWidth === undefined) normalized.minWidth = normalized.minHeight;
		return normalized;
	}

	function syncHeaderToggleState() {
		if (!galleryHost?.shadowRoot) return;
		const saveButton = galleryHost.shadowRoot.getElementById('saveImagesBtn');
		const logButton = galleryHost.shadowRoot.getElementById('logBtn');
		if (saveButton) saveButton.classList.toggle('ig-toggle-active', isSaveDialogOpen());
		if (logButton) logButton.classList.toggle('ig-toggle-active', currentViewMode === 'log');
	}

	function setMainViewMode(mode) {
		if (!galleryHost?.shadowRoot) return;
		currentViewMode = mode;

		const grid = galleryHost.shadowRoot.querySelector('.ig-grid-container');
		const logView = galleryHost.shadowRoot.getElementById('ig-log-view');
		if (!grid || !logView) return;

		grid.style.display = mode === 'gallery' ? 'grid' : 'none';
		logView.style.display = mode === 'log' ? 'flex' : 'none';
		if (mode === 'gallery') updateGridStyle();
		if (mode === 'log') renderLogTable();
		syncHeaderToggleState();
	}

	async function applyManualHiddenState(recordKey, shouldHide) {
		const record = getRecordByKey(recordKey);
		if (!record || record.loadError) return;
		if (shouldHide) {
			manualVisibilityOverrides.set(recordKey, 'hide');
		} else if (record.defaultInGallery) {
			manualVisibilityOverrides.delete(recordKey);
		} else {
			manualVisibilityOverrides.set(recordKey, 'show');
		}
		const gridContainer = galleryHost?.shadowRoot?.querySelector('.ig-grid-container');
		if (gridContainer) await filterAndDisplayImages(allScrapedUrls, gridContainer);
	}

	async function openPopupFromLogRecord(recordKey) {
		const record = getRecordByKey(recordKey);
		if (!record || record.loadError) return;

		const previousOverride = manualVisibilityOverrides.has(recordKey) ? manualVisibilityOverrides.get(recordKey) : undefined;
		if (!record.inGallery) {
			popupTemporaryShownRecord = { recordKey, previousOverride };
			manualVisibilityOverrides.set(recordKey, 'show');
			const gridContainer = galleryHost?.shadowRoot?.querySelector('.ig-grid-container');
			if (gridContainer) await filterAndDisplayImages(allScrapedUrls, gridContainer);
		}

		const galleryIndex = allImageData.findIndex((item) => item.recordKey === recordKey);
		if (galleryIndex >= 0) showImagePopup(galleryIndex);
	}

	async function closePopupAndRestoreTemporaryShownRecord() {
		if (popup) {
			popup.style.display = 'none';
			popup.classList.remove('ig-popup-chrome-hidden');
		}
		if (popupTemporaryShownRecord) {
			const { recordKey, previousOverride } = popupTemporaryShownRecord;
			if (previousOverride === undefined) {
				manualVisibilityOverrides.delete(recordKey);
			} else {
				manualVisibilityOverrides.set(recordKey, previousOverride);
			}
			popupTemporaryShownRecord = null;
			const gridContainer = galleryHost?.shadowRoot?.querySelector('.ig-grid-container');
			if (gridContainer) await filterAndDisplayImages(allScrapedUrls, gridContainer);
			if (currentViewMode === 'log') setMainViewMode('log');
		}
	}

	function updatePopupChromeVisibility(clientX, clientY) {
		if (!popup || popup.style.display !== 'flex') return;

		const popupRect = popup.getBoundingClientRect();
		if (popupRect.width === 0 || popupRect.height === 0) {
			popup.classList.remove('ig-popup-chrome-hidden');
			return;
		}

		const insidePopup = clientX >= popupRect.left && clientX <= popupRect.right && clientY >= popupRect.top && clientY <= popupRect.bottom;
		const inBottomQuarter = insidePopup && clientY >= popupRect.top + (popupRect.height * 0.75);
		popup.classList.toggle('ig-popup-chrome-hidden', inBottomQuarter);
	}

	// --- Popup Zoom View ---

	function navigateTo(newIndex) {
		const totalImages = allImageData.length;
		if (totalImages === 0) return;

		// Prevent wrapping around.
		if (newIndex < 0 || newIndex >= totalImages) {
			return;
		}

		showImagePopup(newIndex);
	}

	function showImagePopup(index) {
		if (index < 0 || index >= allImageData.length) return;

		currentPopupIndex = index;
		const imgData = allImageData[index];
		currentPopupImgData = {
			url: imgData.url,
			displayUrl: imgData.objectUrl || imgData.url,
			naturalWidth: imgData.width,
			naturalHeight: imgData.height,
			alternateUrls: imgData.alternateUrls
		};

		popupImg.src = currentPopupImgData.displayUrl;
		popupImg.draggable = false;
		popup.style.display = 'flex';
		popup.classList.remove('ig-popup-chrome-hidden');
		// Set transform origin to center for all transformations (zoom, rotate, flip)
		popupImg.style.transformOrigin = 'center center';

		popup.tabIndex = 0;
		popup.focus();

		// Reset flip/rotate for the new image
		popupRotation = 0;
		popupScaleX = 1;
		popupScaleY = 1;

		updatePopupInfoBar();
		resetZoomAndPan(); // Initial fit
	}

	function updatePopupZoomIndicator() {
		const zoomSpan = popupInfoBar.querySelector('.zoom');
		if (zoomSpan) zoomSpan.textContent = `(${(scale * 100).toFixed(0)}%)`;
	}

	function getScaleToFit() {
		const containerRect = popupContainer.getBoundingClientRect();
		return Math.min(
			containerRect.width / currentPopupImgData.naturalWidth, // Scale factor for width
			containerRect.height / currentPopupImgData.naturalHeight, // Scale factor for height
		);
	}

	function updatePopupInfoBar() {
		const { naturalWidth, naturalHeight, url, alternateUrls } = currentPopupImgData;
		const zoomPercentage = (scale * 100).toFixed(0);
		const duplicateCount = alternateUrls.length;

		let urlHtml = '';
		try {
			// Handle data URIs separately
			if (String(url).startsWith('data:')) {
				urlHtml = '<span>Data URI</span>';
			} else {
				const urlObj = new URL(String(url));
				let htmlParts = [];

				// 1. Domain
				htmlParts.push(`<span class="url-domain" title="${escapeHtml(url)}">${escapeHtml(urlObj.hostname)}</span>`);

				// 2. Path and Filename
				let pathHtml = '';
				let filenameHtml = '';
				const lastSlashIndex = urlObj.pathname.lastIndexOf('/');
				if (lastSlashIndex !== -1) {
					const pathPart = urlObj.pathname.substring(0, lastSlashIndex + 1);
					const filenamePart = urlObj.pathname.substring(lastSlashIndex + 1);
					if (pathPart) { // Render path even if it's just "/"
						pathHtml = `<span class="url-path" title="${escapeHtml(pathPart)}">${escapeHtml(pathPart)}</span>`;
					}
					if (filenamePart) {
						filenameHtml = `<span class="url-filename">${escapeHtml(filenamePart)}</span>`;
					}
				} else if (urlObj.pathname && urlObj.pathname !== '/') {
					filenameHtml = `<span class="url-filename">${escapeHtml(urlObj.pathname)}</span>`;
				}
				if (pathHtml) htmlParts.push(pathHtml);
				if (filenameHtml) htmlParts.push(filenameHtml);

				// 3. Parameters
				if (urlObj.search) {
					let paramParts = ['<span class="url-param-qmark">?</span>'];
					const params = urlObj.search.substring(1).split('&');
					params.forEach((param, index) => {
						const [key, value] = param.split('=');
						if (key) paramParts.push(`<span class="url-param-key">${escapeHtml(decodeURIComponent(key))}</span>`);
						if (value !== undefined) {
							paramParts.push('<span class="url-param-eq">=</span>');
							paramParts.push(`<span class="url-param-value">${escapeHtml(decodeURIComponent(value))}</span>`);
						}
						if (index < params.length - 1) {
							paramParts.push('<span class="url-param-amp">&amp;</span>');
						}
					});
					const paramsHtml = paramParts.join('');
					htmlParts.push(`<span class="url-parameters" title="${escapeHtml(urlObj.search)}">${paramsHtml}</span>`);
				}

				urlHtml = htmlParts.join('');
			}
		} catch (e) {
			urlHtml = `<span>${url}</span>`; // Fallback to the raw URL if parsing fails
			console.log('could not parse url properly', url);
		}

		if (duplicateCount > 1) {
			const duplicateIndicator = `<span class="ig-duplicate-count" title="${alternateUrls.join('\n')}">(${duplicateCount})</span>`;
			urlHtml += duplicateIndicator;
			// This is a bit of a hack to get the tooltip working here too
			setTimeout(() => {
				const dupIndicator = popupInfoBar.querySelector('.ig-duplicate-count');
				if (!dupIndicator) return;
				dupIndicator.addEventListener('mouseenter', () => { dupIndicator.classList.add('show-tooltip'); });
				dupIndicator.addEventListener('mouseleave', () => { dupIndicator.classList.remove('show-tooltip'); });
			}, 0);
		}

		// set progress bar 
		const progressPercent = allImageData.length > 1 ? (currentPopupIndex / (allImageData.length - 1)) * 100 : 100;

		popupInfoBar.innerHTML = `<div id="progressbar" style="width: ${progressPercent}%"></div><span class="index">[${currentPopupIndex + 1}/${allImageData.length}]</span><span class="dimensions">${naturalWidth}x${naturalHeight}</span><span class="zoom">(${zoomPercentage}%)</span><span class="url">${urlHtml}</span>`;
	}

	function applyTransform() {
		popupImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${popupRotation}deg) scaleX(${popupScaleX}) scaleY(${popupScaleY})`;
		updatePopupInfoBar();
	}

	function resetZoomAndPan() {
		scale = getScaleToFit();
		translateX = 0;
		translateY = 0;
		applyTransform(); // This will also call updatePopupInfoBar via showImagePopup -> resetZoomAndPan
	}

	function pan() {
		if (!popupContainer || !popupImg || !currentPopupImgData.naturalWidth) return;

		const containerRect = popupContainer.getBoundingClientRect();
		const imgWidth = currentPopupImgData.naturalWidth * scale;
		const imgHeight = currentPopupImgData.naturalHeight * scale;

		// How much the image overflows the container. If negative, it's smaller.
		const overflowX = imgWidth - containerRect.width;
		const overflowY = imgHeight - containerRect.height;

		// Mouse position normalized from 0 to 1 within the container.
		const mouseX = mouse.x - containerRect.left;
		const mouseY = mouse.y - containerRect.top;
		const normMouseX = Math.max(0, Math.min(1, mouseX / containerRect.width));
		const normMouseY = Math.max(0, Math.min(1, mouseY / containerRect.height));

		// If the image is larger than the container, calculate the translation.
		// The translation moves the image from a range of [overflow/2, -overflow/2].
		if (overflowX > 0) {
			translateX = (overflowX / 2) - (normMouseX * overflowX);
		} else {
			translateX = 0; // Center the image if it's smaller than the container.
		}
		if (overflowY > 0) {
			translateY = (overflowY / 2) - (normMouseY * overflowY);
		} else {
			translateY = 0;
		}

		applyTransform();
	};

	async function handleGlobalKeyDown(e) {
		const shadow = galleryHost?.shadowRoot;
		const activeElement = shadow?.activeElement || document.activeElement;
		const editingText = Boolean(activeElement && (activeElement.isContentEditable || activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA'));
		const key = String(e.key || '');
		const lowerKey = key.toLowerCase();

		if (e.key === 'Escape') {
			e.preventDefault();
			const host = document.getElementById(GALLERY_HOST_ID);
			if (!host || !host.shadowRoot) return;

			const saveDialog = host.shadowRoot.getElementById('ig-save-dialog-backdrop');
			const popup = host.shadowRoot.getElementById('ig-img-popup');

			if (saveDialog && saveDialog.style.display === 'flex') {
				closeSaveDialog();
			} else if (popup && popup.style.display === 'flex') {
				await closePopupAndRestoreTemporaryShownRecord();
			} else if (currentViewMode === 'log') {
				setMainViewMode('gallery');
			} else {
				closeGallery();
			}
		} else if (e.key === 'Backspace') {
			if (currentlyHoveredImgWrapper) {
				e.preventDefault();
				const hoveredRecord = allImageData.find((record) => record.element === currentlyHoveredImgWrapper);
				if (hoveredRecord) {
					manualVisibilityOverrides.set(hoveredRecord.recordKey, 'hide');
					currentlyHoveredImgWrapper = null; // Clear reference
					const gridContainer = galleryHost?.shadowRoot?.querySelector('.ig-grid-container');
					if (gridContainer) await filterAndDisplayImages(allScrapedUrls, gridContainer);
				}
			}
		} else if (!editingText && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const popupOpen = shadow?.getElementById('ig-img-popup')?.style.display === 'flex';
			if (popupOpen) return;
			if (lowerKey === 'l') {
				e.preventDefault();
				setMainViewMode(currentViewMode === 'log' ? 'gallery' : 'log');
			} else if (lowerKey === 'o') {
				e.preventDefault();
				browser.runtime.sendMessage({ action: 'openOptionsPage' });
			} else if (lowerKey === 's') {
				e.preventDefault();
				if (isSaveDialogOpen()) {
					closeSaveDialog();
				} else {
					openSaveDialog();
				}
			} else if (lowerKey === 'd') {
				e.preventDefault();
				const deriveBtn = shadow?.getElementById('deriveBtn');
				if (!deriveBtn) return;
				deriveBtn.classList.toggle('ig-toggle-active');
				const controls = shadow?.querySelector('.ig-controls');
				controls?.dispatchEvent(new Event('input', { bubbles: true }));
			}
		}
	}

	async function createGalleryUI(imageUrls) {
		galleryHost = document.createElement('div');
		galleryHost.id = GALLERY_HOST_ID;
		const shadow = galleryHost.attachShadow({ mode: 'open' });

		const cssUrl = browser.runtime.getURL('content.css');
		const response = await fetch(cssUrl);
		const cssText = await response.text();

		// Pass settings to the style/HTML template function
		shadow.innerHTML = getShadowHTML(settings, cssText);

		// --- Assign popup elements and attach listeners once ---
		popup = shadow.getElementById('ig-img-popup');
		popupContainer = shadow.getElementById('solo-image');
		popupImg = shadow.querySelector('#solo-image > img');
		popupInfoBar = shadow.getElementById('infobar');

		const navLeft = shadow.querySelector('.ig-popup-nav.left');
		const navRight = shadow.querySelector('.ig-popup-nav.right');

		navLeft.addEventListener('click', (e) => {
			navigateTo(currentPopupIndex - 1);
		});
		navRight.addEventListener('click', (e) => {
			navigateTo(currentPopupIndex + 1);
		});

		// Single wheel event handler at popup level
		popup.addEventListener('wheel', (e) => {
			e.preventDefault();

			// Check if we're over a nav button
			const target = e.target.closest('.ig-popup-nav');
			if (target) {
				const newIndex = e.deltaY < 0 ? currentPopupIndex - 1 : currentPopupIndex + 1;
				navigateTo(newIndex);
				return;
			}

			const oldScale = scale;
			const zoomFactor = e.ctrlKey ? 1.1 : 1.333;
			scale *= e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;

			// Enforce min size
			const minPixelSize = 100; // Don't let the image get too small
			if (currentPopupImgData.naturalWidth * scale < minPixelSize ||
				currentPopupImgData.naturalHeight * scale < minPixelSize) {
				scale = oldScale;
				return;
			}

			// Zoom towards cursor
			const containerRect = popupContainer.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;

			// Adjust translation to keep the point under the cursor stationary.
			// This works because transform-origin is center.
			translateX -= (mouseX - translateX) * (scale / oldScale - 1);
			translateY -= (mouseY - translateY) * (scale / oldScale - 1);

			pan(); // Recalculate pan based on new zoom and mouse position
			updatePopupZoomIndicator();
		});

		popup.addEventListener('keydown', (e) => {
			const totalImages = allImageData.length;
			const jumpAmount = Math.max(1, Math.ceil(totalImages / 10));
			const navigateToPercent = (digit) => {
				if (totalImages <= 0) return;
				const normalizedDigit = Math.max(0, Math.min(9, digit));
				const percent = normalizedDigit / 10;
				const targetIndex = normalizedDigit === 0
					? 0
					: Math.min(totalImages - 1, Math.max(0, Math.ceil(totalImages * percent) - 1));
				navigateTo(targetIndex);
			};

			const digitCodeMatch = String(e.code || '').match(/^(?:Digit|Numpad)(\d)$/);
			if (digitCodeMatch) {
				e.preventDefault();
				navigateToPercent(parseInt(digitCodeMatch[1], 10));
				return;
			}

			if (e.key === 'ArrowRight') {
				e.preventDefault();
				navigateTo(currentPopupIndex + (e.shiftKey ? jumpAmount : 1));
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				navigateTo(currentPopupIndex - (e.shiftKey ? jumpAmount : 1));
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				navigateTo(0);
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				navigateTo(totalImages - 1);
			} else if (e.key === 'Home') {
				e.preventDefault();
				navigateTo(0);
			} else if (e.key === 'End') {
				e.preventDefault();
				navigateTo(totalImages - 1);
			} else if (e.key === 'PageDown') {
				e.preventDefault();
				navigateTo(currentPopupIndex + jumpAmount);
			} else if (e.key === 'PageUp') {
				e.preventDefault();
				navigateTo(currentPopupIndex - jumpAmount);
			} else if (e.key.toLowerCase() === 'x') {
				e.preventDefault();
				popupScaleX *= -1;
				applyTransform(); // Mirror horizontally
			} else if (e.key.toLowerCase() === 'y') {
				e.preventDefault();
				popupScaleY *= -1;
				applyTransform(); // Mirror vertically
			} else if (e.key.toLowerCase() === 'r') {
				e.preventDefault();
				const increment = e.shiftKey ? 5 : 90;
				popupRotation += increment;
				applyTransform();
			} else if (e.key.toLowerCase() === 'w') {
				e.preventDefault();
				const decrement = e.shiftKey ? 5 : 90;
				popupRotation -= decrement;
				applyTransform();
			} else if (e.key.toLowerCase() === 'e') {
				e.preventDefault();
				// Reset flip/rotate state
				popupRotation = 0;
				popupScaleX = 1;
				popupScaleY = 1;
				resetZoomAndPan();
			} else if (e.ctrlKey && e.key.toLowerCase() === 's') {
				e.preventDefault();
				const currentRecord = allImageData[currentPopupIndex];
				if (!currentRecord?.blob) return;

				browser.runtime.sendMessage({
					action: 'saveImages',
					files: [{
						relativePath: getRecordFilenameWithExtension(currentRecord),
						blob: currentRecord.blob
					}],
					postAction: 'save'
				}).catch((error) => {
					console.error('Download failed:', error);
				});
			}
		});

		popupContainer.addEventListener('mousedown', (e) => {
			if (e.button === 1) { // Middle click to toggle natural/fit zoom
				e.preventDefault();
				if (Math.abs(scale - 1.0) < 0.01) { // If it's at original size
					scale = getScaleToFit(); // Go to fit-in-view size
				} else {
					scale = 1.0; // Go to natural size
				}
				translateX = 0;
				translateY = 0;
				applyTransform();
				updatePopupZoomIndicator();
			}
		});

		popupContainer.addEventListener('click', (e) => {
			if (e.button !== 0) return; // Only left click
			// Don't advance if a nav button was clicked
			if (e.target.closest('.ig-popup-nav')) return;

			navigateTo(currentPopupIndex + 1);
		});

		popup.addEventListener('mousemove', (e) => {
			if (popup.style.display !== 'flex') return;
			mouse.x = e.clientX;
			mouse.y = e.clientY;
			pan();
			updatePopupChromeVisibility(e.clientX, e.clientY);
		});
		popup.addEventListener('mouseleave', () => {
			popup.classList.remove('ig-popup-chrome-hidden');
		});

		ensurePageOverlayStyles();
		setPageScrollLock(true);
		document.querySelectorAll('body > *').forEach(item => {
			item.classList.add('amer-image-gallery-hide');
		});
		document.body.appendChild(galleryHost);
		window.addEventListener('keydown', handleGlobalKeyDown);

		const gridContainer = shadow.querySelector('.ig-grid-container');
		const dynamicStyle = document.createElement('style');
		let currentRow = 0;
		let rowHeight = 0;
		dynamicStyle.id = 'ig-dynamic-style';
		dynamicStyle.textContent = `.ig-img-wrapper {
			/* This will be updated by updateGridStyle */
		}`;
		shadow.appendChild(dynamicStyle);

		const calculateGridDimensions = (imageCount, maxCols, maxRows) => {
			if (imageCount <= 0) return { cols: maxCols, rows: maxRows };

			let cols = 1;
			let rows = 1;

			// Cycle increasing cols then rows until we can fit all images or hit maxes
			while (cols * rows < imageCount) {
				const canAddCol = cols < maxCols;
				const canAddRow = rows < maxRows;

				// If we can add both, prefer adding to the smaller dimension to keep it squarish
				if (canAddCol && canAddRow) {
					if (cols <= rows) {
						cols++;
					} else {
						rows++;
					}
				} else if (canAddCol) {
					cols++;
				} else if (canAddRow) {
					rows++;
				} else {
					// Cannot add any more rows or columns
					break;
				}
			}
			return { cols, rows };
		}

		updateGridStyle = () => {
			let maxGridCols = parseInt(shadow.getElementById('gridWidth').value, 10);
			let maxGridRows = parseInt(shadow.getElementById('gridHeight').value, 10);

			// Handle empty values
			if (isNaN(maxGridCols) && isNaN(maxGridRows)) {
				maxGridCols = 5; maxGridRows = 4; // Default
			} else if (isNaN(maxGridCols)) {
				maxGridCols = maxGridRows;
			} else if (isNaN(maxGridRows)) {
				maxGridRows = maxGridCols;
			}

			settings.gridCols = maxGridCols;
			settings.gridRows = maxGridRows;

			const { cols, rows } = calculateGridDimensions(allImageData.length, settings.gridCols, settings.gridRows);

			const gridContainer = shadow.querySelector('.ig-grid-container');
			if (!gridContainer) return; // Guard against element not being ready

			const availableHeight = gridContainer.clientHeight || Math.max(1, shadow.querySelector('.ig-container').clientHeight - shadow.querySelector('.ig-controls').offsetHeight);
			rowHeight = Math.max(1, availableHeight / Math.max(rows, 1));

			gridContainer.style.setProperty('--grid-cols', cols);
			dynamicStyle.textContent = `
				.ig-img-wrapper {
					height: ${rowHeight}px;
				}`;
			currentRow = Math.round(gridContainer.scrollTop / rowHeight);
		};

		const updateGridFilter = () => {
			let minSize = shadow.querySelector('.min-size').value;

			// Handle empty values
			if (minSize === '') {
				minSize = 0;
			}

			settings.minWidth = settings.minHeight = parseInt(minSize, 10);
			settings.includeRegex = shadow.getElementById('includeRegex').value;
			settings.excludeRegex = shadow.getElementById('excludeRegex').value;
			settings.sortBy = shadow.getElementById('sortBy').value;
			settings.deriveOriginals = shadow.getElementById('deriveBtn').classList.contains('ig-toggle-active');

			const compiledRegexes = compileFilterRegexes();
			const includeRegexInput = shadow.getElementById('includeRegex');
			const excludeRegexInput = shadow.getElementById('excludeRegex');
			if (includeRegexInput) {
				includeRegexInput.classList.toggle('ig-invalid-regex', Boolean(compiledRegexes.includeError));
				includeRegexInput.title = compiledRegexes.includeError ? `Invalid regex: ${compiledRegexes.includeError}` : '';
			}
			if (excludeRegexInput) {
				excludeRegexInput.classList.toggle('ig-invalid-regex', Boolean(compiledRegexes.excludeError));
				excludeRegexInput.title = compiledRegexes.excludeError ? `Invalid regex: ${compiledRegexes.excludeError}` : '';
			}

			filterAndDisplayImages(allScrapedUrls, gridContainer);
		};

		await filterAndDisplayImages(imageUrls, gridContainer);

		shadow.getElementById('gridWidth').addEventListener('input', updateGridStyle);
		shadow.getElementById('gridHeight').addEventListener('input', updateGridStyle);
		// Also update grid style on window resize
		window.addEventListener('resize', updateGridStyle);
		shadow.querySelector('.ig-controls').addEventListener('input', updateGridFilter);

		shadow.getElementById('closeBtn').addEventListener('click', closeGallery);
		shadow.getElementById('saveImagesBtn').addEventListener('click', () => {
			if (isSaveDialogOpen()) {
				closeSaveDialog();
			} else {
				openSaveDialog();
			}
		});
		shadow.getElementById('logBtn').addEventListener('click', () => {
			setMainViewMode(currentViewMode === 'log' ? 'gallery' : 'log');
		});
		const markProfileDirty = (dirty = true) => {
			const profileNameEl = shadow.getElementById('profileNameDisplay');
			const profileSaveBtn = shadow.getElementById('profileSaveBtn');
			const trimmedName = profileNameEl.textContent.trim();
			const canSave = dirty && trimmedName !== '' && trimmedName !== 'no profile';
			profileSaveBtn.disabled = !canSave;
			profileSaveBtn.classList.toggle('ig-unsaved', canSave);
		};

		shadow.getElementById('deriveBtn').addEventListener('click', () => {
			const deriveBtn = shadow.getElementById('deriveBtn');
			deriveBtn.classList.toggle('ig-toggle-active');
			markProfileDirty(true);
			updateGridFilter();
		});
		shadow.getElementById('optionsBtn').addEventListener('click', () => {
			browser.runtime.sendMessage({ action: 'openOptionsPage' });
		});

		const saveDialog = shadow.getElementById('ig-save-dialog-backdrop');
		const saveInput = shadow.getElementById('ig-save-name');
		saveDialog.addEventListener('click', (e) => {
			if (e.target === saveDialog) closeSaveDialog();
		});
		saveInput.addEventListener('pointerdown', () => {
			if (!saveInputAutofillArmed || saveInput.value.trim() !== '') return;
			const firstOriginalName = getOriginalSaveList()[0];
			if (!firstOriginalName) return;
			saveInput.value = firstOriginalName;
			saveInputAutofillArmed = false;
			const extensionMatch = firstOriginalName.match(/\.[a-z0-9]{1,8}$/i);
			const selectionEnd = extensionMatch ? firstOriginalName.length - extensionMatch[0].length : firstOriginalName.length;
			requestAnimationFrame(() => saveInput.setSelectionRange(0, selectionEnd));
			updateSaveDialogState();
		});
		saveInput.addEventListener('input', () => {
			activeSaveError = '';
			saveInputAutofillArmed = false;
			updateSaveDialogState();
		});
		shadow.getElementById('ig-save-cancel-btn').addEventListener('click', closeSaveDialog);
		shadow.getElementById('ig-save-all-btn').addEventListener('click', () => saveImages('save'));
		shadow.getElementById('ig-save-explore-btn').addEventListener('click', () => saveImages('explore'));
		shadow.getElementById('ig-save-view-btn').addEventListener('click', () => saveImages('view'));

		shadow.querySelectorAll('#ig-log-view th[data-column]').forEach((header) => {
			header.addEventListener('click', () => {
				const column = header.dataset.column;
				if (logSortState.column === column) {
					logSortState.direction = logSortState.direction === 'asc' ? 'desc' : 'asc';
				} else {
					logSortState = { column, direction: 'asc' };
				}
				renderLogTable();
			});
		});
		shadow.getElementById('ig-log-view').addEventListener('click', (e) => {
			const row = e.target.closest('tr[data-record-key]');
			const recordKey = row?.dataset.recordKey || '';
			if (!recordKey) return;

			const hiddenToggle = e.target.closest('button[data-action="toggle-hidden"]');
			if (hiddenToggle) {
				const record = getRecordByKey(recordKey);
				if (!record) return;
				applyManualHiddenState(recordKey, record.inGallery);
				return;
			}

			const thumb = e.target.closest('.ig-log-thumb-clickable');
			if (thumb) {
				openPopupFromLogRecord(recordKey);
				return;
			}

			const cell = e.target.closest('td[data-highlight-type]');
			if (!cell) return;
			const type = cell.dataset.highlightType;
			const value = cell.dataset.highlightValue ?? '';
			const sourceKey = cell.dataset.highlightSource || `${type}:${value}`;
			if (!type) return;
			if (value === '' && type !== 'width' && type !== 'height') return;
			setLogHighlightState({ type, value, sourceKey });
		});

		const logView = shadow.getElementById('ig-log-view');
		logView.addEventListener('wheel', (e) => {
			if (currentViewMode !== 'log') return;
			e.preventDefault();
			logView.scrollTop += e.deltaY;
			logView.scrollLeft += e.deltaX;
		}, { passive: false });

		// --- New, Self-Contained Scroll Wheel Functionality ---
		const controlsContainer = shadow.querySelector('.ig-controls');
		controlsContainer.addEventListener('wheel', (e) => {
			const target = e.target;

			// Handle number inputs
			if (target.matches('input[type="number"]')) {
				e.preventDefault();
				const step = Number(target.step) || 1;
				let value = Number(target.value) || 0;

				if (e.deltaY < 0) { // scroll up -> increase value
					value += step;
				} else { // scroll down -> decrease value
					value -= step;
				}

				const min = target.min !== '' ? Number(target.min) : -Infinity;
				if (value < min) value = min;

				target.value = value;
				target.dispatchEvent(new Event('input', { bubbles: true }));
			}

			// Handle select inputs
			if (target.matches('select')) {
				e.preventDefault();
				const currentIndex = target.selectedIndex;
				let newIndex;

				if (e.deltaY < 0) { // scroll up
					newIndex = Math.max(0, currentIndex - 1);
				} else { // scroll down
					newIndex = Math.min(target.options.length - 1, currentIndex + 1);
				}

				if (newIndex !== currentIndex) {
					target.selectedIndex = newIndex;
					target.dispatchEvent(new Event('input', { bubbles: true }));
				}
			}
		}, { passive: false });

		galleryHost.addEventListener('wheel', (e) => {
			if (popup && popup.style.display === 'flex') return;
			if (currentViewMode !== 'log') return;

			const controlsEl = shadow.querySelector('.ig-controls');
			const saveDialogBackdrop = shadow.getElementById('ig-save-dialog-backdrop');
			const inLogView = logView.contains(e.target);
			const inControls = controlsEl ? controlsEl.contains(e.target) : false;
			const inOpenSaveDialog = isSaveDialogOpen() && saveDialogBackdrop && saveDialogBackdrop.contains(e.target);

			if (!inLogView && !inControls && !inOpenSaveDialog) {
				e.preventDefault();
			}
		}, { passive: false });

		const profileNameEl = shadow.getElementById('profileNameDisplay');
		const profileUrlRegexEl = shadow.querySelector('.url-regex');
		const profileSaveBtn = shadow.getElementById('profileSaveBtn');

		// --- Profile Management Logic ---

		// Add listeners to all controls to enable saving on change
		const controlInputs = shadow.querySelectorAll('.ig-container > .ig-controls input, .ig-container > .ig-controls select');
		controlInputs.forEach(input => {
			if (input.id !== 'ig-save-name') {
				input.addEventListener('input', () => markProfileDirty(true));
			}
		});

		const beginProfileNameEditing = () => {
			profileNameEl.contentEditable = true;
			profileNameEl.focus();
			setSelectionToElementContents(profileNameEl);
		};

		// Double-click to edit profile name
		let originalProfileName = '';
		profileNameEl.addEventListener('dblclick', () => {
			originalProfileName = profileNameEl.textContent.trim();
			beginProfileNameEditing();
		});

		const finishNameEditing = (save) => {
			profileNameEl.contentEditable = false;
			if (save) {
				if (profileNameEl.textContent.trim() === '') {
					profileNameEl.textContent = originalProfileName || 'no profile';
				} else if (profileNameEl.textContent !== originalProfileName) {
					markProfileDirty(true);
				}
			} else {
				profileNameEl.textContent = originalProfileName || 'no profile';
			}
			const isPlaceholder = !sessionActiveProfile && profileNameEl.textContent.trim() === 'no profile';
			profileNameEl.classList.toggle('placeholder', isPlaceholder);
		};

		profileNameEl.addEventListener('blur', () => finishNameEditing(true));
		profileNameEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				finishNameEditing(true);
				profileNameEl.blur();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finishNameEditing(false);
				profileNameEl.blur();
			}
		});

		// Add a click listener to auto-populate the name for a new profile
		profileNameEl.addEventListener('click', () => {
			if (sessionActiveProfile) return;
			if (!profileNameEl.classList.contains('placeholder')) return;

			// Extract domain name without subdomains or TLD
			const hostnameParts = window.location.hostname.split('.');
			let domainName = 'profile'; // fallback
			if (hostnameParts.length > 1) {
				domainName = hostnameParts[hostnameParts.length - 2];
			}

			profileNameEl.textContent = domainName;
			profileNameEl.classList.remove('placeholder');
			// Also populate the URL regex at the same time
			if (profileUrlRegexEl.value.trim() === '') {
				profileUrlRegexEl.value = `^${escapeRegexText(window.location.origin + window.location.pathname)}.*`;
			}

			beginProfileNameEditing();
			markProfileDirty(true);
		});

		// Listener for creating a new profile
		profileNameEl.addEventListener('input', () => {
			if (sessionActiveProfile) return; // This listener is only for new profiles

			const currentText = profileNameEl.textContent.trim();
			const urlInput = profileUrlRegexEl;

			// If it's the first time typing, remove placeholder and suggest a URL regex
			if (profileNameEl.classList.contains('placeholder')) {
				profileNameEl.classList.remove('placeholder');
				if (currentText.startsWith('no profile')) profileNameEl.textContent = '';

				if (urlInput.value.trim() === '') {
					urlInput.value = `^${escapeRegexText(window.location.origin + window.location.pathname)}.*`;
				}
			}
			markProfileDirty(true);
		});

		const saveOrUpdateProfile = async () => {

			const profileName = profileNameEl.textContent.trim();
			const urlRegex = profileUrlRegexEl.value.trim();

			if (!profileName) {
				alert("Profile name cannot be empty.");
				profileNameEl.textContent = sessionActiveProfile?.name || 'no profile';
				return;
			}

			const data = await browser.storage.sync.get('profiles');
			const profiles = data.profiles || [];

			// The original name to find in storage. For new profiles, this is null.
			const originalName = sessionActiveProfile ? sessionActiveProfile.name : null;

			const newProfile = {
				name: profileName,
				urlRegex: urlRegex,
				settings: { ...settings }
			};

			// If we are updating, find by the original name.
			const existingIndex = originalName ? profiles.findIndex(p => p.name === originalName) : -1;

			if (existingIndex > -1) { // Update existing
				profiles[existingIndex] = newProfile;
			} else if (profiles.some(p => p.name === profileName)) {
				alert(`A profile named "${profileName}" already exists. Please choose a different name.`);
				return;
			} else {
				profiles.push(newProfile);
			}

			await browser.storage.sync.set({ profiles });

			// Update the session and UI state
			sessionActiveProfile = newProfile;
			profileNameEl.contentEditable = false; // Make it non-editable until dbl-clicked again
			profileNameEl.classList.remove('placeholder');
			markProfileDirty(false);
		};

		profileSaveBtn.addEventListener('click', saveOrUpdateProfile);

		// Add listener to show all info boxes on controls hover
		const controls = shadow.querySelector('.ig-controls');
		const grid = shadow.querySelector('.ig-grid-container');

		// If a profile was loaded, update the UI to reflect it.
		if (sessionActiveProfile) {
			profileNameEl.textContent = sessionActiveProfile.name;
			profileUrlRegexEl.value = sessionActiveProfile.urlRegex || '';
			profileNameEl.classList.remove('placeholder');
		} else {
			profileNameEl.textContent = 'no profile';
			profileNameEl.classList.add('placeholder');
			profileNameEl.contentEditable = true;
		}
		markProfileDirty(false);

		controls.addEventListener('mouseenter', () => {
			grid.classList.add('ig-show-all-info');
		});
		controls.addEventListener('mouseleave', () => {
			grid.classList.remove('ig-show-all-info');
		});

		const handleRowScroll = (direction, isPageJump = false) => {
			if (rowHeight <= 0) return false; // Return false to indicate failure

			const maxGridRows = parseInt(shadow.getElementById('gridHeight').value, 10) || settings.gridRows;
			const jumpAmount = isPageJump ? maxGridRows : 1;

			const { cols } = calculateGridDimensions(allImageData.length, settings.gridCols, settings.gridRows);
			const totalRows = Math.ceil(allImageData.length / cols);
			const visibleRows = Math.floor(grid.clientHeight / rowHeight);

			let newRow = currentRow;
			if (direction === 'down') {
				newRow = Math.min(Math.max(0, totalRows - visibleRows), currentRow + jumpAmount);
			} else if (direction === 'up') {
				newRow = Math.max(0, currentRow - jumpAmount);
			}

			if (newRow !== currentRow) {
				currentRow = newRow;
				grid.scrollTo({
					top: currentRow * rowHeight,
					behavior: 'smooth'
				});
			}
			return true; // Return true to indicate success
		};

		grid.addEventListener('wheel', (e) => {
			// Try to handle with row scroll first. If it succeeds, prevent default.
			// If it fails (e.g., rowHeight not set), allow native scroll.
			if (handleRowScroll(e.deltaY > 0 ? 'down' : 'up')) {
				e.preventDefault();
			}
		}, { passive: false });

		// Add keydown listener to the gallery host for scrolling
		galleryHost.addEventListener('keydown', (e) => {
			if (currentViewMode !== 'gallery') return;
			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					handleRowScroll('down');
					break;
				case 'ArrowUp':
					e.preventDefault();
					handleRowScroll('up');
					break;
				case 'PageDown':
					e.preventDefault();
					handleRowScroll('down', true);
					break;
				case 'PageUp':
					e.preventDefault();
					handleRowScroll('up', true);
					break;
			}
		});

		// Initial grid style setup
		updateGridStyle();
		updateSaveDialogState();
		updateGridFilter();
		renderLogTable();
		setMainViewMode('gallery');
		syncHeaderToggleState();

		// Focus the host to receive keydown events
		galleryHost.tabIndex = -1;
		galleryHost.focus();
	}

	// This function is now responsible for removing the resize listener
	async function openGallery() {
		allScrapedUrls = scrapeImageUrls(); // Always re-scrape when opening
		if (DEBUG) {
			console.log("--- Image Embiggener Debug Log ---");
			console.log(debug_log);
		}

		hasRunFullScan = true;
		if (!galleryHost) { // First time opening, create it
			await createGalleryUI(allScrapedUrls);
		} else { // Gallery already exists, just update and show it
			const gridContainer = galleryHost.shadowRoot.querySelector('.ig-grid-container');
			await filterAndDisplayImages(allScrapedUrls, gridContainer);
			galleryHost.style.display = 'block';
			ensurePageOverlayStyles();
			setPageScrollLock(true);
			// Ensure other page content is hidden
			document.querySelectorAll('body > *').forEach(item => { if (item.id !== GALLERY_HOST_ID) item.classList.add('amer-image-gallery-hide'); });
			window.addEventListener('keydown', handleGlobalKeyDown);

			// Sometimes the initial refresh can leave the grid empty due to timing/state
			// — dispatch an input event on the controls to force the filter/update handler
			// (this mirrors what happens when the user edits settings and fixes the empty grid).
			try {
				const controls = galleryHost.shadowRoot.querySelector('.ig-controls');
				if (controls) {
					controls.dispatchEvent(new Event('input', { bubbles: true }));
				}
			} catch (e) {
				// Non-fatal; continue to focus gallery
				if (DEBUG) console.error('Failed to dispatch input event to gallery controls', e);
			}

			galleryHost.focus(); // Re-focus when opening
		}
	}

	window.closeGallery = function () {
		window.removeEventListener('keydown', handleGlobalKeyDown);
		if (galleryHost) {
			closeSaveDialog();
			void closePopupAndRestoreTemporaryShownRecord();
			setMainViewMode('gallery');
			galleryHost.style.display = 'none'; // Hide instead of removing
			document.querySelectorAll('.amer-image-gallery-hide').forEach(item => {
				item.classList.remove('amer-image-gallery-hide');
			});
		}
		setPageScrollLock(false);
		if (window.igSessionInitialized) {
			setupPageObserver();
		}
	}

	window.toggleGallery = async function () {
		// If session isn't initialized yet, run it now.
		if (!sessionActiveProfile && !window.igSessionInitialized) await initializeSession();

		// Check if the gallery element exists and is visible
		if (galleryHost && galleryHost.style.display !== 'none') {
			closeGallery();
		} else {
			cleanupPageObserver(); // Stop observing while gallery is open
			await openGallery(); // Now open the gallery
		}
	}

	// --- One-time Initialization ---
	async function initializeSession() {
		window.igSessionInitialized = true;
		const data = await browser.storage.sync.get(['profiles', 'defaultProfile']);

		const profiles = data.profiles || [];
		const defaultProfile = normalizeStoredProfileSettings(data.defaultProfile || {
			gridCols: 5,
			gridRows: 4,
			minWidth: 200,
			minHeight: 200,
			sortBy: 'dom',
			deriveOriginals: true,
			includeRegex: '',
			excludeRegex: ''
		});

		// Sort profiles by regex length, descending. This ensures the most specific match is found first.
		profiles.sort((a, b) => b.urlRegex.length - a.urlRegex.length);

		let activeProfile = null; // Use a local variable for the loop
		for (const profile of profiles) {
			try {
				if (new RegExp(profile.urlRegex).test(window.location.href)) {
					activeProfile = profile;
					break;
				}
			} catch (e) {
				console.error("Invalid regex in profile:", profile.name);
			}
		}

		sessionActiveProfile = activeProfile; // Store in session-level variable
		const loadedSettings = normalizeStoredProfileSettings(activeProfile ? activeProfile.settings : defaultProfile);

		// Merge the loaded settings into our persistent session `settings` object.
		// This ensures defaults are present if the profile is missing keys.
		Object.assign(settings, defaultProfile, loadedSettings);

		// Now that settings are loaded, we can start the page observer for accurate badge counts.
		setupPageObserver();
	}

	// Add new styles to the getShadowHTML function's style block
	function getShadowHTML(currentSettings, cssText) {
		const checker1 = "#444";
		const checker2 = "#222";
		const checker3 = "#232323";
		const checker4 = "#202020";
		const checksSmall = "25px";
		const checksLarge = "150px";


		cssText = `
			:host {
				--img-bg: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='${checker1.replace('#', '%23')}'/><rect x='0' y='0' width='16' height='16' fill='${checker2.replace('#', '%23')}'/><rect x='16' y='16' width='16' height='16' fill='${checker2.replace('#', '%23')}'/></svg>");
				--img-bg-size: ${checksSmall};
				--img-solo-bg: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='${checker3.replace('#', '%23')}'/><rect x='0' y='0' width='16' height='16' fill='${checker4.replace('#', '%23')}'/><rect x='16' y='16' width='16' height='16' fill='${checker4.replace('#', '%23')}'/></svg>");
				--img-solo-bg-size: ${checksLarge};
			}
		` + cssText;

		return `
			<style>${cssText}</style>
			<div id="ig-img-popup">
				<div class="ig-popup-nav left" title="Previous Image">
					<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</div>
				<div id="solo-image">
					<img>
				</div>
				<div class="ig-popup-nav right" title="Next Image">
					<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
				</div>
				<div id="infobar">
					<div id="progressbar"></div>
					<!-- The duplicate count in the popup needs a different tooltip implementation due to how it's rendered -->
					<template id="ig-popup-tooltip-template">
						<div class="ig-duplicate-tooltip-popup">
							<!-- content will be injected here -->
						</div>
					</template>
				</div>
			</div>
			<div class="ig-container">
				<div class="ig-controls">
					<div class="ig-profile-controls">
						<span id="profileNameDisplay" class="ig-profile-name" title="Double-click to rename"></span>
						<button id="profileSaveBtn" title="Save Profile Changes" disabled>Save</button>
						<input type="text" class="url-regex">
					</div>
					<label>Cols: <input type="number" id="gridWidth" value="${currentSettings.gridCols || 5}"></label>
					<label>Rows: <input type="number" id="gridHeight" value="${currentSettings.gridRows || 4}"></label>
					<label>Min px: <input type="number" step="50" class="min-size" value="${currentSettings.minWidth}"></label>
					<label>Sort:
						<select id="sortBy">
							<option value="dom" ${currentSettings.sortBy === 'dom' ? 'selected' : ''}>Original</option>
							<option value="path" ${currentSettings.sortBy === 'path' ? 'selected' : ''}>Path</option>
							<option value="filename" ${currentSettings.sortBy === 'filename' ? 'selected' : ''}>File Name</option>
							<option value="pixels" ${currentSettings.sortBy === 'pixels' ? 'selected' : ''}>Pixels</option>
						</select>
					</label>
					<label>Include: <input type="text" id="includeRegex" value="${currentSettings.includeRegex || ''}"></label>
					<label>Exclude: <input type="text" id="excludeRegex" value="${currentSettings.excludeRegex || ''}"></label>
					<button id="deriveBtn" class="${currentSettings.deriveOriginals !== false ? 'ig-toggle-active' : ''}" title="Attempt to discover larger files based on filename."><span class="ig-hotkey">D</span>erive</button>
					<button id="saveImagesBtn" title="Save Images"><span class="ig-hotkey">S</span>ave Images</button>
					<button id="logBtn"><span class="ig-hotkey">L</span>og</button>
					<button id="optionsBtn"><span class="ig-hotkey">O</span>ptions</button>
					<button id="closeBtn" title="Close Gallery (Esc)">&#x2715;</button>
				</div>
				<div class="ig-grid-container"></div>
				<div id="ig-log-view">
					<table>
						<thead>
							<tr>
								<th data-column="galleryIndex">#</th>
								<th>Thumb</th>
								<th data-column="path">Path</th>
								<th data-column="filename">Filename</th>
								<th data-column="fileType">Type</th>
								<th data-column="width">Width</th>
								<th data-column="height">Height</th>
								<th data-column="hidden">Hidden</th>
								<th data-column="filter">Filter</th>
							</tr>
						</thead>
						<tbody id="ig-log-body"></tbody>
					</table>
				</div>
				<div id="ig-loading-notifier">
					<span></span>
				</div>
				<div id="ig-save-dialog-backdrop">
					<div id="ig-save-dialog" role="dialog" aria-modal="true" aria-labelledby="ig-save-dialog-title">
						<h2 id="ig-save-dialog-title">Save Images</h2>
						<input id="ig-save-name" type="text" placeholder="">
						<div id="ig-save-actions">
							<button id="ig-save-view-btn">Save &amp; View</button>
							<button id="ig-save-explore-btn">Save &amp; Explore</button>
							<button id="ig-save-all-btn">Save All</button>
							<button id="ig-save-cancel-btn">Cancel</button>
						</div>
						<ul id="ig-save-list"></ul>
						<div id="ig-save-error"></div>
					</div>
				</div>
			</div>
		   `;
	}

	// --- Initial call when the script is first injected ---
	// Remove: toggleGallery();

	// Listen for toggle message from background.js
	browser.runtime.onMessage.addListener((msg) => {
		if (msg?.action === 'toggleGallery') {
			return toggleGallery();
		}
		return false;
	});

	// --- Initial call when the script is first injected ---
	// Load settings from storage, then set up the observer for badge counting.
	if (document.body) {
		initializeSession();
	} else {
		// If the script runs before the body is ready (e.g., with run_at: "document_start"),
		// wait for the DOM to be loaded before initializing.
		document.addEventListener('DOMContentLoaded', initializeSession, {
			once: true
		});
	}
}
