import { describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readFile } from 'node:fs/promises';

if (typeof document === 'undefined') GlobalRegistrator.register();

describe('FlowKit application document', () => {
  it('loads the specified font families with document links', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const fontLinks = Array.from(parsed.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((link) => link.href);

    expect(fontLinks).toHaveLength(1);
    expect(fontLinks[0]).toContain('fonts.googleapis.com/css2');
    expect(fontLinks[0]).toContain('Archivo');
    expect(fontLinks[0]).toContain('DM+Sans');
    expect(fontLinks[0]).toContain('JetBrains+Mono');
  });

  it('keeps the desktop application rail at the specified width', async () => {
    const style = document.createElement('style');
    style.textContent = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
    document.head.append(style);
    const rules = Array.from(style.sheet?.cssRules ?? []);
    const appShell = rules.find((rule) => 'selectorText' in rule && rule.selectorText === '.app-shell') as CSSStyleRule;
    const loading = rules.find((rule) => 'selectorText' in rule && rule.selectorText === '.route-loading') as CSSStyleRule;

    expect(appShell.style.gridTemplateColumns).toStartWith('256px');
    expect(loading.style.left).toBe('256px');
    style.remove();
  });
});
