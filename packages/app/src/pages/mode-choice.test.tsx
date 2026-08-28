import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModeChoicePage } from './mode-choice';

describe('ModeChoicePage', () => {
  it('renders both choices as labelled native keyboard controls', () => {
    const html = renderToStaticMarkup(<ModeChoicePage savingMode={null} error={null} onSelect={() => undefined} />);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Use apps. Continue as a user"');
    expect(html).toContain('aria-label="Build apps. Continue as a developer"');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain('Settings → Mode');
  });

  it('only shows the saving label on the selected choice', () => {
    const html = renderToStaticMarkup(<ModeChoicePage savingMode="user" error={null} onSelect={() => undefined} />);
    expect(html.match(/Saving…/g)).toHaveLength(1);
    expect(html).toContain('Continue as a developer');
  });
});
