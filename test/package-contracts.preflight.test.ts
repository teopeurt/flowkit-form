import { describe, expect, it } from 'bun:test';
import manifest from '../package-contracts.json';

describe('public Flowkit package contract', () => {
  it('documents the consumer facade as the demo command boundary', () => {
    expect(manifest['@naakwu/flowkit-consumer']).toEqual({ entrypoints: ['.'], symbols: ['createFlowkitConsumer'] });
  });

  it('imports every documented entry point and symbol', async () => {
    for (const [pkg, contract] of Object.entries(manifest)) {
      for (const entrypoint of contract.entrypoints) {
        const module = await import(entrypoint === '.' ? pkg : `${pkg}${entrypoint.slice(1)}`);
        for (const symbol of contract.symbols) expect(symbol in module, `${pkg}${entrypoint} missing ${symbol}`).toBe(true);
      }
    }
  });
});
