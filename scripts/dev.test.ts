import { describe, expect, it } from 'bun:test';

import { validatePackageRegistryConfig } from './dev';

const safeNpmrc = `@naakwu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}
always-auth=true
`;

describe('validatePackageRegistryConfig', () => {
  it('accepts only the expected GitHub Packages scope and credential variable', () => {
    expect(() => validatePackageRegistryConfig({
      npmrc: safeNpmrc,
      environment: { NODE_AUTH_TOKEN: 'github_pat_example' },
    })).not.toThrow();
  });

  it.each([
    '@naakwu:registry=http://127.0.0.1:4873',
    '@naakwu:registry=https://registry.npmjs.org',
    '@other:registry=https://npm.pkg.github.com',
  ])('rejects the wrong package registry without printing credentials', (registry) => {
    expect(() => validatePackageRegistryConfig({
      npmrc: safeNpmrc.replace('@naakwu:registry=https://npm.pkg.github.com', registry),
      environment: { NODE_AUTH_TOKEN: 'do-not-print-this' },
    })).toThrow('exact @naakwu GitHub Packages registry');
  });

  it('rejects an inline registry credential', () => {
    expect(() => validatePackageRegistryConfig({
      npmrc: safeNpmrc.replace('${NODE_AUTH_TOKEN}', 'inline-secret'),
      environment: { NODE_AUTH_TOKEN: 'different-secret' },
    })).toThrow('NODE_AUTH_TOKEN variable');
  });

  it.each([undefined, '', 'replace-with-github-packages-read-token'])('rejects a missing or placeholder credential', (token) => {
    expect(() => validatePackageRegistryConfig({
      npmrc: safeNpmrc,
      environment: { NODE_AUTH_TOKEN: token },
    })).toThrow('NODE_AUTH_TOKEN is required');
  });

  it('never includes the credential value in a validation error', () => {
    const token = 'credential-that-must-stay-secret';
    try {
      validatePackageRegistryConfig({ npmrc: '', environment: { NODE_AUTH_TOKEN: token } });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it.each([
    `${safeNpmrc}@naakwu:registry=https://registry.npmjs.org\n`,
    `${safeNpmrc}//npm.pkg.github.com/:_authToken=inline-secret\n`,
    `${safeNpmrc}always-auth=false\n`,
    `${safeNpmrc}@naakwu:registry=https://npm.pkg.github.com\n`,
  ])('rejects duplicate or conflicting security settings', (npmrc) => {
    expect(() => validatePackageRegistryConfig({
      npmrc,
      environment: { NODE_AUTH_TOKEN: 'valid-token' },
    })).toThrow('exactly once');
  });

  it('rejects an unrelated inline auth token assignment', () => {
    expect(() => validatePackageRegistryConfig({
      npmrc: `${safeNpmrc}//registry.npmjs.org/:_authToken=inline-secret\n`,
      environment: { NODE_AUTH_TOKEN: 'valid-token' },
    })).toThrow('Inline package registry tokens are forbidden');
  });
});
