<script lang="ts">
	import { onMount } from 'svelte';
	import { Spinner } from 'flowbite-svelte';
	import { nav, currentView } from '$lib/util/hash-router';
	import { promptAddLibrary, promptEditLibrary, type AddLibraryModalParams } from '$lib/util/modals';

	// URL params for pre-filling form
	interface ViewParams {
		url?: string;
		name?: string;
		username?: string;
		path?: string;
		id?: string; // For editing existing library
	}

	onMount(() => {
		const view = $currentView;
		if (view.type === 'add-library') {
			const params = (view.params || {}) as ViewParams;

			// Check for edit mode
			if (params.id) {
				// Navigate to libraries and open edit modal
				nav.toLibraries();
				// Small delay to ensure navigation completes before opening modal
				setTimeout(() => {
					promptEditLibrary(params.id!);
				}, 50);
			} else {
				// Navigate to libraries and open add modal with params
				const modalParams: AddLibraryModalParams = {};
				if (params.url) modalParams.url = params.url;
				if (params.name) modalParams.name = params.name;
				if (params.username) modalParams.username = params.username;
				if (params.path) modalParams.path = params.path;

				nav.toLibraries();
				// Small delay to ensure navigation completes before opening modal
				setTimeout(() => {
					promptAddLibrary(Object.keys(modalParams).length > 0 ? modalParams : undefined);
				}, 50);
			}
		}
	});
</script>

<!-- Brief loading state while redirecting -->
<div class="flex h-64 items-center justify-center">
	<Spinner size="8" />
</div>
