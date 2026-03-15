console.log('background.js loaded.');

const objectUrlsByDownloadId = new Map();
const downloadWaiters = new Map();

browser.browserAction.setBadgeBackgroundColor({ color: '#000' });
browser.browserAction.setBadgeTextColor({ color: '#fff' });

browser.browserAction.onClicked.addListener((tab) => {
	browser.browserAction.setBadgeBackgroundColor({ color: '#fff', tabId: tab.id });
	browser.browserAction.setBadgeTextColor({ color: '#000', tabId: tab.id });
	browser.tabs.sendMessage(tab.id, { action: 'toggleGallery' }).catch(() => {
		console.log('Image Embiggener cannot run on this page.');
	});
});

function settleDownloadWaiter(id, error) {
	const waiter = downloadWaiters.get(id);
	if (!waiter) return;

	downloadWaiters.delete(id);
	if (error) {
		waiter.reject(new Error(error));
	} else {
		waiter.resolve();
	}
}

browser.downloads.onChanged.addListener((delta) => {
	if (!delta.state || !delta.state.current) return;

	if (delta.state.current === 'complete') {
		settleDownloadWaiter(delta.id, null);
	} else if (delta.state.current === 'interrupted') {
		settleDownloadWaiter(delta.id, delta.error?.current || 'Download interrupted');
	}

	if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
		const objectUrl = objectUrlsByDownloadId.get(delta.id);
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
			objectUrlsByDownloadId.delete(delta.id);
		}
	}
});

async function waitForDownloadComplete(id) {
	const [downloadItem] = await browser.downloads.search({ id });
	if (downloadItem?.state === 'complete') return;
	if (downloadItem?.state === 'interrupted') {
		throw new Error(downloadItem.error || 'Download interrupted');
	}

	return new Promise((resolve, reject) => {
		downloadWaiters.set(id, { resolve, reject });
	});
}

function normalizeDownloadFilename(filename) {
	return String(filename || '').replace(/\\/g, '/').toLowerCase();
}

async function checkSaveCollisions(message) {
	const files = Array.isArray(message.files) ? message.files : [];
	const collisions = [];

	for (const relativePath of files) {
		const normalizedTarget = normalizeDownloadFilename(`Image Embiggener/${relativePath}`);
		const filenameRegex = `${escapeForRegex(relativePath.split('/').pop() || relativePath)}$`;
		const matches = await browser.downloads.search({ filenameRegex });
		const hasExactMatch = matches.some((item) => normalizeDownloadFilename(item.filename).endsWith(normalizedTarget));
		if (hasExactMatch) collisions.push(relativePath);
	}

	return { collisions };
}

function escapeForRegex(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function saveImages(message) {
	const { files = [], postAction = 'save' } = message;

	if (!Array.isArray(files) || files.length === 0) {
		throw new Error('No files were provided for saving.');
	}

	const downloadIds = [];
	for (const file of files) {
		if (!file || !(file.blob instanceof Blob) || !file.relativePath) {
			throw new Error('A save request contained invalid file data.');
		}

		const objectUrl = URL.createObjectURL(file.blob);
		let downloadId;
		try {
			downloadId = await browser.downloads.download({
				url: objectUrl,
				filename: `Image Embiggener/${file.relativePath}`,
				conflictAction: 'uniquify',
				saveAs: false
			});
		} catch (error) {
			URL.revokeObjectURL(objectUrl);
			throw error;
		}

		objectUrlsByDownloadId.set(downloadId, objectUrl);
		downloadIds.push(downloadId);
	}

	await Promise.all(downloadIds.map(waitForDownloadComplete));

	if (downloadIds.length > 0) {
		if (postAction === 'explore') {
			await browser.downloads.show(downloadIds[0]);
		} else if (postAction === 'view') {
			await browser.downloads.open(downloadIds[0]);
		}
	}

	return { count: downloadIds.length };
}

browser.runtime.onMessage.addListener((message, sender) => {
	if (message.action === 'openOptionsPage') {
		return browser.runtime.openOptionsPage();
	}

	if (message.action === 'updateBadge') {
		return browser.browserAction.setBadgeText({
			text: message.count.toString(),
			tabId: sender.tab.id
		});
	}

	if (message.action === 'clearBadge') {
		return browser.browserAction.setBadgeText({
			text: '',
			tabId: sender.tab.id
		});
	}

	if (message.action === 'saveImages') {
		return saveImages(message);
	}

	if (message.action === 'checkSaveCollisions') {
		return checkSaveCollisions(message);
	}

	return undefined;
});
