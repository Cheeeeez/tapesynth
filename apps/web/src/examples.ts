// Bundled at build time from /examples (path is relative to apps/web/src).
const raw = import.meta.glob('../../../examples/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export type Example = { name: string; kind: 'verilog' | 'pla'; source: string };

export const EXAMPLES: Example[] = Object.entries(raw)
  .map(([path, source]) => {
    const name = path.split('/').pop()!;
    return { name, kind: name.endsWith('.pla') ? ('pla' as const) : ('verilog' as const), source };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
