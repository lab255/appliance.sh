import { describe, expect, it } from 'vitest';
import { errorMessage } from './installed-apps';

describe('errorMessage', () => {
  it('preserves a Tauri invoke string rejection', () => {
    expect(errorMessage('Bundle is not a regular file: C:\\x.zip', 'Installation failed.')).toBe(
      'Bundle is not a regular file: C:\\x.zip'
    );
  });

  it('uses an Error message', () => {
    expect(errorMessage(new Error('install exploded'), 'Installation failed.')).toBe('install exploded');
  });

  it('uses the fallback for empty rejection text', () => {
    expect(errorMessage('', 'Installation failed.')).toBe('Installation failed.');
    expect(errorMessage('   ', 'Installation failed.')).toBe('Installation failed.');
  });
});
