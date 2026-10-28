import v8 from 'node:v8';

export class SynthError extends Error {
  code: string;
  log: string;
  constructor(code: string, message: string, log = '') {
    super(message);
    this.name = 'SynthError';
    this.code = code;
    this.log = log;
  }
}

export type YosysRun = { files: Record<string, string>; log: string };

let flagSet = false;
/** Node 22 needs --experimental-wasm-exnref for the YoWASP build; V8 flags can be set at runtime before the first compile. */
function ensureWasmFlags() {
  if (flagSet) return;
  flagSet = true;
  v8.setFlagsFromString('--experimental-wasm-exnref');
}

const TOP_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
export const isIdentifier = (s: string) => TOP_RE.test(s);

/** Run Yosys (WASM) on a virtual filesystem; returns text of the files it produced. */
export async function runYosysScript(design: string, script: string): Promise<YosysRun> {
  ensureWasmFlags();
  const mod = await import('@yowasp/yosys');
  let log = '';
  const sink = (s: unknown) => {
    if (typeof s === 'string') log += s;
    else if (s) log += new TextDecoder().decode(s as Uint8Array);
  };
  try {
    const tree = await mod.runYosys(['-q', '-s', '/run.ys'], { 'design.v': design, 'run.ys': script }, { stdout: sink, stderr: sink, decodeASCII: true, fetchProgress: () => {} });
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(tree ?? {})) {
      if (typeof v === 'string') files[k] = v;
      else if (v instanceof Uint8Array) files[k] = new TextDecoder().decode(v);
    }
    return { files, log };
  } catch (e) {
    const err = e as Error & { code?: number };
    const msg = String(err.message ?? e);
    if (/exnref|CompileError/.test(msg) && !log)
      throw new SynthError('yosys-unavailable', `WebAssembly runtime lacks exnref support; run node with --experimental-wasm-exnref (${msg})`);
    throw new SynthError('yosys-failed', lastErrorLine(log) || msg, log);
  }
}

function lastErrorLine(log: string): string {
  const lines = log.split('\n').filter((l) => /error/i.test(l));
  return lines.length ? lines[lines.length - 1]!.trim() : '';
}

export async function yosysVersion(): Promise<string> {
  const mod = await import('@yowasp/yosys');
  return mod.version;
}
