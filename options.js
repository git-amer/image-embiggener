// options.js

document.addEventListener('DOMContentLoaded', () => {
	// --- New Scroll Wheel Functionality ---
	document.body.addEventListener('wheel', (e) => {
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
			// Manually dispatch an 'input' event to trigger auto-save logic
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
	}, { passive: false }); // passive: false is needed for preventDefault

	const profilesList = document.getElementById('profiles-list');
	const defaultSettingsForm = document.getElementById('default-settings-form');
	const defaultForm = {
		gridCols: document.getElementById('default-gridCols'),
		gridRows: document.getElementById('default-gridRows'),
		minSize: document.getElementById('default-minSize'),
		sortBy: document.getElementById('default-sortBy'),
		deriveOriginals: document.getElementById('default-deriveOriginals')
	};

	const flashSaveIndicator = () => {
		const header = document.querySelector('#OptionsHeader > span');
		if (!header) return;

		header.classList.add('flash-save');
		setTimeout(() => {
			header.classList.remove('flash-save');
		}, 1000); // A bit longer than the 2s fade-out transition
	};

	let isSortedByUrl = false;

	const sortProfilesBtn = document.getElementById('sort-profiles-btn');
	sortProfilesBtn.addEventListener('click', () => {
		isSortedByUrl = !isSortedByUrl;
		sortProfilesBtn.textContent = isSortedByUrl ? 'Sorting by URL' : 'Sorting by Index';
		sortProfilesBtn.title = `Toggle sort order (currently by ${isSortedByUrl ? 'URL' : 'Index'})`;
		loadData();
	});

	const loadData = async () => {
		// *** CORRECTED LINE ***
		const data = await browser.storage.sync.get(['profiles', 'defaultProfile']);
		let profiles = data.profiles || [];

		if (isSortedByUrl) {
			profiles.sort((a, b) => {
				const urlA = a.urlRegex || '';
				const urlB = b.urlRegex || '';
				return urlA.localeCompare(urlB);
			});
		}
		const defaultProfile = data.defaultProfile || {
			gridCols: 5,
			gridRows: 4,
			minWidth: 50, // minHeight will be derived from this
			sortBy: 'dom',
			deriveOriginals: true,
			includeRegex: '',
			excludeRegex: ''
		};

		// Populate default settings form
		// Compatibility for old default settings format
		if (defaultProfile.gridImgWidth || defaultProfile.gridImgHeight) {
			defaultProfile.gridCols = 5;
			defaultProfile.gridRows = 4;
			delete defaultProfile.gridImgWidth;
			delete defaultProfile.gridImgHeight;
		}
		// For new 'minSize' input
		defaultProfile.minSize = defaultProfile.minWidth;
		if (defaultProfile.deriveOriginals === undefined) defaultProfile.deriveOriginals = true;

		for (const key in defaultForm) {
			if (!defaultForm[key]) continue;
			if (defaultForm[key].type === 'checkbox') {
				defaultForm[key].checked = defaultProfile[key] !== false;
			} else {
				defaultForm[key].value = defaultProfile[key] || '';
			}
		}

		// Populate profiles list
		profilesList.innerHTML = '';
		profiles.forEach((profile, index) => {
			// Compatibility for old profile format
			if (profile.settings.gridImgWidth || profile.settings.gridImgHeight) {
				profile.settings.gridCols = profile.settings.gridImgWidth > 20 ? Math.round(1200 / profile.settings.gridImgWidth) : 5;
				profile.settings.gridRows = profile.settings.gridImgHeight > 20 ? Math.round(800 / profile.settings.gridImgHeight) : 4;
				delete profile.settings.gridImgWidth;
				delete profile.settings.gridImgHeight;
			}
			if (profile.settings.deriveOriginals === undefined) profile.settings.deriveOriginals = true;

			const div = document.createElement('div');
			div.className = 'ig-controls profile-row options-table-row';
			div.innerHTML = `
				<div class="ig-profile-controls">
					<input type="text" class="profile-name" value="${profile.name}" data-index="${index}" placeholder="Profile Name">
					<input type="text" data-index="${index}" class="url-regex" value="${profile.urlRegex}" placeholder="URL Regex">
				</div>
				<div class="options-split-cell"><input type="number" data-index="${index}" class="grid-cols" value="${profile.settings.gridCols}"></div>
				<div class="options-split-cell"><input type="number" data-index="${index}" class="grid-rows" value="${profile.settings.gridRows}"></div>
				<div class="options-split-cell"><input type="number" data-index="${index}" class="min-size" value="${profile.settings.minWidth}"></div>
				<div class="options-split-cell">
					<select data-index="${index}" class="sort-by">
						<option value="dom" ${profile.settings.sortBy === 'dom' ? 'selected' : ''}>Original</option>
						<option value="path" ${profile.settings.sortBy === 'path' ? 'selected' : ''}>Path</option>
						<option value="filename" ${profile.settings.sortBy === 'filename' ? 'selected' : ''}>File Name</option>
						<option value="pixels" ${profile.settings.sortBy === 'pixels' ? 'selected' : ''}>Pixels</option>
					</select>
				</div>
				<div class="options-split-cell ig-options-derive"><input type="checkbox" data-index="${index}" class="derive-originals" ${profile.settings.deriveOriginals !== false ? 'checked' : ''}></div>
				<div class="options-split-cell"><input type="text" data-index="${index}" class="include-regex" value="${profile.settings.includeRegex || ''}"></div>
				<div class="options-split-cell"><input type="text" data-index="${index}" class="exclude-regex" value="${profile.settings.excludeRegex || ''}"></div>
				<div class="options-row-action"><button class="delete-btn" data-index="${index}" title="Delete Profile">&#x2715;</button></div>
            `;
			profilesList.appendChild(div);
		});
	};

	const saveDefaultSettings = async () => {
		const defaultProfile = {};
		const minSize = Number(defaultForm.minSize.value);
		defaultProfile.minWidth = minSize;
		defaultProfile.minHeight = minSize;

		for (const key in defaultForm) {
			if (key === 'minSize') continue;
			if (defaultForm[key].type === 'checkbox') {
				defaultProfile[key] = defaultForm[key].checked;
			} else {
				defaultProfile[key] = defaultForm[key].type === 'number' ? Number(defaultForm[key].value) : defaultForm[key].value;
			}
		}
		// *** CORRECTED LINE ***
		await browser.storage.sync.set({ defaultProfile });
		// alert('Default settings saved!'); // Removed per request
	};

	// Auto-save default settings
	let defaultSaveTimeout;
	defaultSettingsForm.addEventListener('input', () => {
		clearTimeout(defaultSaveTimeout);
		defaultSaveTimeout = setTimeout(async () => {
			await saveDefaultSettings();
			flashSaveIndicator();
			console.log('Default settings auto-saved.');
		}, 500);
	});
	// Event delegation for delete buttons
	profilesList.addEventListener('click', async (e) => {
		const index = e.target.dataset.index;
		if (index === undefined || !e.target.classList.contains('delete-btn')) return;

		const data = await browser.storage.sync.get('profiles');
		let profiles = data.profiles || [];

		if (e.target.classList.contains('delete-btn')) {
			if (confirm(`Are you sure you want to delete the profile "${profiles[index].name}"?`)) {
				profiles.splice(index, 1);
				// *** CORRECTED LINE ***
				await browser.storage.sync.set({ profiles });
				loadData(); // Reload the list
			}
		}
	});

	document.getElementById('add-profile-btn').addEventListener('click', async () => {
		const data = await browser.storage.sync.get('profiles');
		const profiles = data.profiles || [];
		profiles.push({
			name: 'New Profile',
			urlRegex: '',
			settings: {
				gridCols: 5,
				gridRows: 4,
				minWidth: 50,
				minHeight: 50,
				sortBy: 'dom',
				deriveOriginals: true,
				includeRegex: '',
				excludeRegex: ''
			}
		});
		await browser.storage.sync.set({ profiles });
		loadData();
	});

	// Auto-save on input change
	let saveTimeout;
	profilesList.addEventListener('input', (e) => {
		const index = e.target.dataset.index;
		if (index === undefined) return;

		// Debounce saving to avoid excessive writes
		clearTimeout(saveTimeout);
		saveTimeout = setTimeout(async () => {
			const data = await browser.storage.sync.get('profiles');
			let profiles = data.profiles || [];

			if (profiles[index]) {
				const card = e.target.closest('.profile-row');
				const minSize = Number(card.querySelector('.min-size').value);
				profiles[index] = {
					name: card.querySelector('.profile-name').value,
					urlRegex: card.querySelector('.url-regex').value,
					settings: {
						gridCols: Number(card.querySelector('.grid-cols').value),
						gridRows: Number(card.querySelector('.grid-rows').value),
						minWidth: minSize,
						minHeight: minSize,
						sortBy: card.querySelector('.sort-by').value,
						deriveOriginals: card.querySelector('.derive-originals').checked,
						includeRegex: card.querySelector('.include-regex').value,
						excludeRegex: card.querySelector('.exclude-regex').value
					}
				};
				await browser.storage.sync.set({ profiles });
				flashSaveIndicator();
				console.log(`Profile '${profiles[index].name}' auto-saved.`);
			}
		}, 500); // Save 500ms after the last input
	});

	// Add listener for Enter key on profile name to blur and trigger save
	profilesList.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && e.target.classList.contains('profile-name')) {
			e.preventDefault(); // Prevent form submission if it were in a form
			e.target.blur(); // Triggers focus loss, which the 'input' listener's debounce will handle
		}
	});


	loadData();
});
