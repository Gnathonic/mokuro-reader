<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Modal, Spinner, Helper, Label, Input } from 'flowbite-svelte';
	import { CheckCircleSolid, ExclamationCircleSolid } from 'flowbite-svelte-icons';
	import {
		addLibraryModalStore,
		closeAddLibraryModal,
		type AddLibraryModalParams
	} from '$lib/util/modals';
	import {
		addLibrary,
		updateLibrary,
		getLibraryById,
		type LibraryConfig
	} from '$lib/settings/libraries';
	import { createLibraryClient, fetchLibrary, clearClientCache } from '$lib/util/libraries';
	import { showSnackbar } from '$lib/util';

	let open = $state(false);

	// Form state
	let name = $state('');
	let serverUrl = $state('');
	let username = $state('');
	let password = $state('');
	let basePath = $state('/');

	// UI state
	let testing = $state(false);
	let saving = $state(false);
	let testResult = $state<'success' | 'error' | null>(null);
	let testError = $state<string | null>(null);
	let editMode = $state(false);
	let editingId = $state<string | null>(null);

	// Generate shareable URL based on form inputs
	let shareableUrl = $derived.by(() => {
		if (!serverUrl) return '';
		const baseUrl = window.location.origin + '/#/add-library';
		const params = new URLSearchParams();
		params.set('url', serverUrl);
		if (name) params.set('name', name);
		if (username) params.set('username', username);
		if (basePath && basePath !== '/') params.set('path', basePath);
		return `${baseUrl}?${params.toString()}`;
	});

	onMount(() => {
		const unsubscribe = addLibraryModalStore.subscribe((value) => {
			if (value?.open) {
				open = true;
				resetForm();

				// Check for edit mode
				if (value.editingId) {
					const library = getLibraryById(value.editingId);
					if (library) {
						editMode = true;
						editingId = library.id;
						name = library.name;
						serverUrl = library.serverUrl;
						username = library.username || '';
						password = library.password || '';
						basePath = library.basePath || '/';
						return;
					}
				}

				// New library with optional params
				editMode = false;
				editingId = null;
				if (value.params) {
					initFromParams(value.params);
				}
			}
		});
		return unsubscribe;
	});

	function initFromParams(params: AddLibraryModalParams) {
		if (params.url) serverUrl = params.url;
		if (params.name) name = params.name;
		if (params.username) username = params.username;
		if (params.path) basePath = params.path;

		// Generate name from URL if not provided
		if (params.url && !params.name) {
			try {
				const url = new URL(params.url);
				name = url.hostname;
			} catch {
				// Invalid URL, ignore
			}
		}
	}

	function resetForm() {
		name = '';
		serverUrl = '';
		username = '';
		password = '';
		basePath = '/';
		testing = false;
		saving = false;
		testResult = null;
		testError = null;
		editMode = false;
		editingId = null;
	}

	// Test connection
	async function handleTest() {
		if (!serverUrl) {
			showSnackbar('Server URL is required');
			return;
		}

		testing = true;
		testResult = null;
		testError = null;

		try {
			const tempConfig: LibraryConfig = {
				id: 'temp-test',
				name: name || 'Test',
				serverUrl,
				username: username || undefined,
				password: password || undefined,
				basePath: basePath || '/',
				createdAt: new Date().toISOString()
			};

			const client = createLibraryClient(tempConfig);
			await client.testConnection({ timeout: 15000 });

			testResult = 'success';
			showSnackbar('Connection successful!');
		} catch (error) {
			testResult = 'error';
			testError = error instanceof Error ? error.message : 'Connection failed';
			console.error('Connection test failed:', error);
		} finally {
			testing = false;
		}
	}

	// Save library
	async function handleSave() {
		if (!serverUrl) {
			showSnackbar('Server URL is required');
			return;
		}

		let finalName = name;
		if (!finalName) {
			// Generate name from URL
			try {
				const url = new URL(serverUrl);
				finalName = url.hostname;
			} catch {
				showSnackbar('Please enter a name for the library');
				return;
			}
		}

		saving = true;

		try {
			if (editMode && editingId) {
				// Update existing library
				updateLibrary(editingId, {
					name: finalName,
					serverUrl,
					username: username || undefined,
					password: password || undefined,
					basePath: basePath || '/'
				});
				// Clear cached client so it uses new credentials
				clearClientCache(editingId);
				showSnackbar(`${finalName} updated`);
			} else {
				// Add new library
				const newLibrary = addLibrary({
					name: finalName,
					serverUrl,
					username: username || undefined,
					password: password || undefined,
					basePath: basePath || '/'
				});

				// Try to fetch files from the new library
				try {
					await fetchLibrary(newLibrary);
					showSnackbar(`${finalName} added and loaded`);
				} catch {
					showSnackbar(`${finalName} added (could not load files)`);
				}
			}

			// Call onSave callback if provided
			if ($addLibraryModalStore?.onSave) {
				$addLibraryModalStore.onSave();
			}

			handleClose();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to save library';
			showSnackbar(message);
			console.error('Failed to save library:', error);
		} finally {
			saving = false;
		}
	}

	function handleClose() {
		open = false;
		closeAddLibraryModal();
	}

	function handleCancel() {
		if ($addLibraryModalStore?.onCancel) {
			$addLibraryModalStore.onCancel();
		}
		handleClose();
	}
</script>

<Modal bind:open size="md" onclose={handleClose}>
	<div class="p-2">
		<h3 class="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
			{editMode ? 'Edit Library' : 'Add Library'}
		</h3>

		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleSave();
			}}
			class="flex flex-col gap-4"
		>
			<!-- Server URL -->
			<div>
				<Label for="serverUrl" class="mb-2">Server URL *</Label>
				<Input
					id="serverUrl"
					type="url"
					bind:value={serverUrl}
					placeholder="https://cloud.example.com/dav"
					required
				/>
				<Helper class="mt-1">
					The WebDAV server URL (e.g., https://your-server.com/remote.php/dav/files/username)
				</Helper>
			</div>

			<!-- Name -->
			<div>
				<Label for="name" class="mb-2">Display Name</Label>
				<Input id="name" type="text" bind:value={name} placeholder="My Library" />
				<Helper class="mt-1">
					A friendly name to identify this library (auto-generated from URL if empty)
				</Helper>
			</div>

			<!-- Base Path -->
			<div>
				<Label for="basePath" class="mb-2">Base Path</Label>
				<Input id="basePath" type="text" bind:value={basePath} placeholder="/" />
				<Helper class="mt-1">
					Subfolder to browse (default: / for root). Example: /manga or /books
				</Helper>
			</div>

			<!-- Username -->
			<div>
				<Label for="username" class="mb-2">Username (optional)</Label>
				<Input
					id="username"
					type="text"
					bind:value={username}
					placeholder="username"
					autocomplete="username"
				/>
			</div>

			<!-- Password -->
			<div>
				<Label for="password" class="mb-2">Password (optional)</Label>
				<Input
					id="password"
					type="password"
					bind:value={password}
					placeholder="password or app token"
					autocomplete="current-password"
				/>
				<Helper class="mt-1">Some servers require an app-specific password or token</Helper>
			</div>

			<!-- Test Result -->
			{#if testResult}
				<div
					class="p-3 rounded-lg flex items-center gap-2 {testResult === 'success'
						? 'bg-green-50 dark:bg-green-900/20'
						: 'bg-red-50 dark:bg-red-900/20'}"
				>
					{#if testResult === 'success'}
						<CheckCircleSolid class="h-5 w-5 text-green-500" />
						<span class="text-green-700 dark:text-green-400">Connection successful!</span>
					{:else}
						<ExclamationCircleSolid class="h-5 w-5 text-red-500" />
						<span class="text-red-700 dark:text-red-400">{testError || 'Connection failed'}</span>
					{/if}
				</div>
			{/if}

			<!-- Shareable URL (only for new libraries) -->
			{#if !editMode && shareableUrl}
				<div class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
					<p class="text-xs text-gray-500 dark:text-gray-400 mb-1">Shareable link:</p>
					<code
						class="block p-2 bg-gray-200 dark:bg-gray-700 rounded text-xs overflow-x-auto break-all text-gray-800 dark:text-gray-200"
					>
						{shareableUrl}
					</code>
				</div>
			{/if}

			<!-- Actions -->
			<div class="flex gap-3 mt-2 relative z-10">
				<Button
					type="button"
					color="light"
					onclick={handleTest}
					disabled={testing || !serverUrl}
				>
					{#if testing}
						<Spinner size="4" class="me-2" />
						Testing...
					{:else}
						Test Connection
					{/if}
				</Button>
				<div class="flex-1"></div>
				<Button type="button" color="alternative" onclick={handleCancel} disabled={saving}>
					Cancel
				</Button>
				<Button type="submit" color="primary" disabled={saving || !serverUrl}>
					{#if saving}
						<Spinner size="4" class="me-2" />
						Saving...
					{:else}
						{editMode ? 'Save Changes' : 'Add Library'}
					{/if}
				</Button>
			</div>
		</form>
	</div>
</Modal>
