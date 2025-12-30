/**
 * Tauri-specific file handling utilities
 * Uses native dialogs and filesystem access in Tauri
 */
import { isTauri } from './tauri';

/**
 * Open a native folder picker dialog in Tauri
 * Returns an array of File objects from the selected folder
 */
export async function pickFolderTauri(): Promise<File[]> {
	if (!isTauri()) {
		throw new Error('pickFolderTauri called outside Tauri context');
	}

	const { open } = await import('@tauri-apps/plugin-dialog');
	const { readDir, readFile } = await import('@tauri-apps/plugin-fs');

	// Open native folder picker
	const selected = await open({
		directory: true,
		multiple: false,
		title: 'Select folder to import'
	});

	if (!selected) {
		return []; // User cancelled
	}

	const folderPath = selected as string;
	const files: File[] = [];

	// Recursively read all files from the folder
	await readFolderRecursive(folderPath, '', files, readDir, readFile);

	return files;
}

/**
 * Recursively read files from a folder
 */
async function readFolderRecursive(
	basePath: string,
	relativePath: string,
	files: File[],
	readDir: typeof import('@tauri-apps/plugin-fs').readDir,
	readFile: typeof import('@tauri-apps/plugin-fs').readFile
): Promise<void> {
	const currentPath = relativePath ? `${basePath}/${relativePath}` : basePath;
	const entries = await readDir(currentPath);

	for (const entry of entries) {
		const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

		if (entry.isDirectory) {
			await readFolderRecursive(basePath, entryRelativePath, files, readDir, readFile);
		} else if (entry.isFile) {
			try {
				const fullPath = `${currentPath}/${entry.name}`;
				const contents = await readFile(fullPath);

				// Determine MIME type from extension
				const ext = entry.name.split('.').pop()?.toLowerCase() || '';
				const mimeType = getMimeType(ext);

				// Create a File object with the webkitRelativePath set
				const file = new File([contents], entry.name, { type: mimeType });
				// Add webkitRelativePath as a property (needed by the upload logic)
				Object.defineProperty(file, 'webkitRelativePath', {
					value: entryRelativePath,
					writable: false
				});

				files.push(file);
			} catch (error) {
				console.warn(`Failed to read file ${entry.name}:`, error);
			}
		}
	}
}

/**
 * Open a native file picker dialog in Tauri
 * Returns an array of File objects
 */
export async function pickFilesTauri(): Promise<File[]> {
	if (!isTauri()) {
		throw new Error('pickFilesTauri called outside Tauri context');
	}

	const { open } = await import('@tauri-apps/plugin-dialog');
	const { readFile } = await import('@tauri-apps/plugin-fs');

	// Open native file picker
	const selected = await open({
		multiple: true,
		title: 'Select files to import',
		filters: [
			{
				name: 'Manga files',
				extensions: ['zip', 'cbz', 'mokuro']
			}
		]
	});

	console.log('[Tauri] pickFilesTauri - selected paths:', selected);

	if (!selected) {
		return []; // User cancelled
	}

	const paths = Array.isArray(selected) ? selected : [selected];
	const files: File[] = [];

	for (const path of paths) {
		try {
			console.log('[Tauri] Reading file:', path);
			const contents = await readFile(path);
			console.log('[Tauri] Read file contents, size:', contents.byteLength);

			const fileName = path.split('/').pop() || path.split('\\').pop() || 'unknown';
			const ext = fileName.split('.').pop()?.toLowerCase() || '';
			const mimeType = getMimeType(ext);

			const file = new File([contents], fileName, { type: mimeType });
			console.log('[Tauri] Created File object:', file.name, 'size:', file.size, 'type:', file.type);
			files.push(file);
		} catch (error) {
			console.error(`[Tauri] Failed to read file ${path}:`, error);
		}
	}

	console.log('[Tauri] Total files created:', files.length);
	return files;
}

/**
 * Read files from an array of paths (for drag-drop support in Tauri)
 * Recursively reads directories and returns all files
 */
export async function readFilesFromPaths(paths: string[]): Promise<File[]> {
	if (!isTauri()) {
		throw new Error('readFilesFromPaths called outside Tauri context');
	}

	console.log('[Tauri] readFilesFromPaths - paths:', paths);

	const { readDir, readFile, stat } = await import('@tauri-apps/plugin-fs');
	const files: File[] = [];

	for (const path of paths) {
		try {
			console.log('[Tauri] Checking path:', path);
			const info = await stat(path);
			console.log('[Tauri] Path info:', { isDirectory: info.isDirectory, isFile: info.isFile });

			if (info.isDirectory) {
				// Recursively read directory
				await readFolderRecursive(path, '', files, readDir, readFile);
			} else if (info.isFile) {
				console.log('[Tauri] Reading file:', path);
				const contents = await readFile(path);
				console.log('[Tauri] Read file contents, size:', contents.byteLength);

				const fileName = path.split('/').pop() || path.split('\\').pop() || 'unknown';
				const ext = fileName.split('.').pop()?.toLowerCase() || '';
				const mimeType = getMimeType(ext);

				const file = new File([contents], fileName, { type: mimeType });
				console.log('[Tauri] Created File object:', file.name, 'size:', file.size);
				files.push(file);
			}
		} catch (error) {
			console.error(`[Tauri] Failed to read path ${path}:`, error);
		}
	}

	console.log('[Tauri] Total files created:', files.length);
	return files;
}

/**
 * Get MIME type from file extension
 */
function getMimeType(ext: string): string {
	const mimeTypes: Record<string, string> = {
		zip: 'application/zip',
		cbz: 'application/x-cbz',
		mokuro: 'application/json',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		png: 'image/png',
		gif: 'image/gif',
		webp: 'image/webp',
		json: 'application/json'
	};
	return mimeTypes[ext] || 'application/octet-stream';
}
