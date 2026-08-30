import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FriendlyError } from './friendly-error';

describe('FriendlyError', () => {
  it('makes raw technical details copyable', () => {
    const html = renderToStaticMarkup(
      <FriendlyError error={new Error('appliance cloud update --local')} fallbackHeadline="Update failed" />
    );
    expect(html).toContain('aria-label="Copy log"');
    expect(html).toContain('Technical details');
  });
});
