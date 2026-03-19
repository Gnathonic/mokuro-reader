import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	timeout: 30000,
	use: {
		baseURL: 'http://localhost:5173',
		viewport: { width: 1920, height: 1080 }
	},
	webServer: {
		command: 'npm run dev -- --port 5173',
		port: 5173,
		reuseExistingServer: true
	}
});
