# TapeSynth

Toolchain for [TapeOut](https://tapeout.world) on **X Layer** (chain 196): write a circuit in Verilog or a PLA truth table, or pull one from the chain, and get a **synthesized, optimized and verified TAP-02 netlist** (NAND/LATCH) you can tape out in one step, then check against the chain's own `eval`/`step`.

TAP-02 names "Compilers (Verilog to TapeOut…)" as its motivation; until now every circuit was wired by hand.

```
Verilog ─┐                       ┌─ exhaustive / random simulation vs the pre-ABC design
PLA ─────┼─ Yosys + ABC ─ NAND ──┤
on-chain ┘  (REFs flattened)     └─ tapeout on X Layer ─ eval/step check against the chain
```

## What it does

| | |
|---|---|
| **Synthesis** | Yosys (WASM) + ABC map to NAND, DFFs become LATCHes. Several ABC flows run, the best by area / depth / PoD cost `C = A·d³` wins. |
| **Verification (always on)** | The netlist is simulated against the pre-ABC design: exhaustive for ≤ 16 inputs, 4,096 random vectors otherwise, 64×32 random beats for sequential circuits. A netlist that fails is never returned. |
| **Optimize on-chain circuits** | `tapesynth optimize <processor> <id>` reads a circuit (inlining `REF`s), re-synthesizes it and prints before/after gate count, depth, `C` and PoD quality `q`. |
| **Tape out** | Reads fees live, mints missing transistors, simulates the call, taps out, then verifies `circuitInfo`, the netlist bytes and `eval`/`step` results on-chain. |
| **DeWEB** | `tapesynth publish` uploads the web app to a circuit's container (SiteRegistry) and activates `<id>.2.<P>.tape`; `tapesynth site verify` re-reads every file through the TapeKit kernel. |

Three front ends share one core: an open-source CLI, an HTTP API (free + paid "Pro" jobs), and a web app hosted on DeWEB.

## Quick start

Node 22, npm.

```bash
git clone --recurse-submodules https://github.com/Cheeeeez/tapesynth && cd tapesynth
npm install && npm run build:libs
npx tapesynth synth examples/spend_policy.v --objective pod --out spend.tsyn.json
npx tapesynth info spend.tsyn.json --cref 297
npx tapesynth sim  spend.tsyn.json --inputs 0x…
```

`counter4.v` (sequential): `tapesynth synth examples/counter4.v && tapesynth sim counter4.tsyn.json --inputs 0x01 --beats 3` prints `q = 0, 1, 2` (a LATCH delays one beat).

Optimize a circuit that is already on X Layer (read-only, no key needed):

```bash
npx tapesynth optimize 0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b 1
```

## Taping out

```bash
cp .env.example .env            # set PRIVATE_KEY (needs OKB on X Layer)
npx tapesynth tapeout spend.tsyn.json --processor <address|number> --mint
npx tapesynth verify <processor> <circuit id> --against spend.tsyn.json
```

Taping out is permanent and costs real OKB: the plan (fees, mints, total) is printed and confirmed first. A processor whose transistors are sold out (for example FAB-Genesis) cannot mint; buy transistors on its market.

## CLI

| Command | |
|---|---|
| `synth <file> [--kind verilog\|pla\|netlist] [--top] [--clock clk] [--objective area\|depth\|pod] [--out] [--remote]` | `--remote` uses `$TAPESYNTH_API` (free tier) |
| `info <x.tsyn.json> [--cref N]` | metrics, pin map, verification, PoD quality |
| `sim <x.tsyn.json> --inputs 0x.. [--state 0x..] [--beats N]` | local simulator |
| `import <processor> <id>` | on-chain circuit → `.tsyn.json` (REFs flattened, checked against `circuitInfo` and `step`) |
| `optimize <processor> <id> [--objective pod]` | import + re-synthesize + comparison table |
| `processor create --name --symbol --story --supply --price` | create a processor (fixed forever) |
| `tapeout <x.tsyn.json> --processor <addr\|n> [--mint] [--yes]` | plan, confirm, tape out, verify |
| `verify <processor> <id> --against <x.tsyn.json>` | byte-for-byte netlist + eval/step check |
| `publish <dir> --processor <addr\|n> --id <n> [--months 6] [--dry-run]` | upload a static site to DeWEB |
| `site verify <name>` | verify every file of `<id>.2.<P>.tape` against the chain |

Input conventions: inputs are the module's input bits in declaration order, LSB first; the clock port (`clk`) is not an input (one beat = one clock edge); outputs are the output bits in declaration order. The `pins` field of the `.tsyn.json` records the map.

## API

`GET /v1/health` · `POST /v1/synth` (free: area/depth, ≤ 256 KB source, ≤ 5,000 gates, 30 s) · `POST /v1/jobs` → `POST /v1/jobs/:id/payment {txHash}` → `GET /v1/jobs/:id` (Pro: any objective, all flows + re-synthesis rounds, ≤ 50,000 gates, 120 s; paid by an OKB transfer to the treasury whose calldata is the job id) · `GET /v1/stats`.

Run it: `TREASURY_ADDRESS=0x… node apps/server/dist/index.js` (see `.env.example`, `Dockerfile`, `fly.toml`).

## Layout

```
packages/core    TAP-02 codec/validate/simulate, PoD metrics, Yosys JSON → netlist, peephole, PLA, REF flatten, X Layer chain module (viem). Browser-safe.
packages/synth   Yosys WASM runner, candidate flows, reference simulator, verification (Node)
packages/cli     tapesynth
apps/server      Fastify API, payments, worker-thread queue
apps/web         Vite + React app (built for DeWEB: relative base, no external URLs)
vendor/TapeKit   submodule: the TapeKit kernel used by `site verify`
deployments/     addresses of the TapeSynth processor and its circuits
examples/        popcount8, adder8, spend_policy, counter4, xor3.pla
```

## Tests

`npm test` runs the official TAP-02 vectors (valid, ill-formed, packing), the converter/peephole/placement tests (200 random netlists checked for behavioural equivalence), the synthesis + verification tests and the API tests.

## License

MIT.
