import { describe, expect, test } from 'bun:test';
import { isStaleBuild } from '../src/components/custom/PageErrorBoundary.tsx';

describe('isStaleBuild', () => {
  test('recognizes failed page loads in each browser, and nothing else', () => {
    expect(isStaleBuild(new TypeError('Failed to fetch dynamically imported module: https://x/SettingsPage-abc.js'))).toBe(true); // Chrome
    expect(isStaleBuild(new TypeError('error loading dynamically imported module: https://x/a.js'))).toBe(true); // Firefox
    expect(isStaleBuild(new TypeError('Importing a module script failed.'))).toBe(true); // Safari
    expect(isStaleBuild(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });
});
