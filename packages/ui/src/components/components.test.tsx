import { afterEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFile } from 'node:fs/promises';

import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Panel,
  SelectField,
  TextField,
} from './index';

if (typeof document === 'undefined') GlobalRegistrator.register();

afterEach(cleanup);

describe('FlowKit UI primitives', () => {
  it('keeps controls keyboard operable with explicit accessible names', async () => {
    const view = render(
      <form>
        <TextField label="Work email" name="email" type="email" required />
        <SelectField label="Organization" name="organization" options={[{ value: 'acme', label: 'Acme Demo' }]} />
        <Button type="submit">Continue</Button>
      </form>,
    );
    const user = userEvent.setup({ document: window.document });

    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Work email' }));
    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('combobox', { name: 'Organization' }));
    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Continue' }));
  });

  it('announces loading and errors while empty content stays instructional', () => {
    const view = render(
      <>
        <LoadingState label="Loading requests" />
        <Alert tone="error" title="Requests unavailable">Refresh the page and try again.</Alert>
        <Panel title="Notifications" meta={<Badge tone="neutral">0 unread</Badge>}>
          <EmptyState title="No notifications">Updates about your requests will appear here.</EmptyState>
        </Panel>
      </>,
    );

    expect(view.getByRole('status').textContent).toContain('Loading requests');
    expect(view.getByRole('alert').textContent).toContain('Refresh the page and try again.');
    expect(view.getByRole('region', { name: 'Notifications' }).textContent).toContain('No notifications');
  });

  it('applies the specified primary action and keyboard focus geometry', async () => {
    const style = document.createElement('style');
    style.textContent = (await readFile(new URL('../tokens.css', import.meta.url), 'utf8')).replace(/^@import[^\n]+\n/, '');
    document.head.append(style);
    const view = render(<Button variant="primary">Continue</Button>);
    const button = view.getByRole('button', { name: 'Continue' });
    button.focus();
    const computed = getComputedStyle(button);

    expect(computed.borderRadius).toBe('8px');
    expect(computed.paddingTop).toBe('16px');
    expect(computed.paddingBottom).toBe('16px');
    const focusRule = Array.from(style.sheet?.cssRules ?? []).find((rule) => 'selectorText' in rule && rule.selectorText === ':focus-visible') as CSSStyleRule;
    expect(focusRule.style.outlineWidth).toBe('2px');
    expect(focusRule.style.outlineColor).toBe('var(--fk-accent)');
    style.remove();
  });
});
