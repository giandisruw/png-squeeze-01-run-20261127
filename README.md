[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/giandisruw/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/giandisruw/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# PNG Squeeze — lossless screenshot re-encoder

A Node 22 program (`main.ts`, builtins only, no network) that rewrites each
1280x720 RGBA screenshot as the smallest lossless PNG it can.

How it works:

- Decodes the stored input PNG and analyses it (opaque? grey? at most 256
  colours? a single fully-transparent colour?).
- Tries every exact form that can hold the image: palette (colour type 3,
  three index orderings: by count, by luminance, and a greedy
  nearest-neighbour path through RGB space), grey (0), grey+alpha (4),
  RGB (2, with a tRNS key when every transparent pixel shares one colour),
  and RGBA (6).
- For each form it tries per-row filter selections — fixed filters 0/1/2/4,
  the PNG-spec minimum-sum heuristic, a fewest-distinct-pairs heuristic,
  and per-row brute force (each filter weighed by a real level-4 deflate of
  the row against the 32 KiB before it) — and weighs every candidate with a
  real zlib level-6 deflate.
- It re-encodes the three best candidates with zlib level 9, zlib level 9
  with Z_FILTERED, and (for the top candidate) a custom zopfli-style
  deflate: hash-chain lazy LZ77 whose match choice maximises bit savings
  against the ~2-bit average literal cost of filtered screenshot data, then
  per-block dynamic Huffman with package-merge length limiting. The custom
  stream is verified by inflating it and comparing bytes; any failure falls
  back to zlib. The smallest complete file wins.

Everything is deterministic: no clock, no environment-based variation, no
randomness. One run over a set of 8 takes about 23 seconds on one CPU,
inside the 60-second wall budget.

Practice-set score: 708,443 (house baseline fixed-paeth: 420,399).
All 8 instances answered exactly; two runs produce byte-identical outputs.

## Run it

On a practice set, point the entry at the input and output directories:

```sh
node main.ts /input /output
```

Each PNG under `/input` is re-encoded losslessly and written to the matching
path under `/output`. Node 22, no dependencies, no network.

Built for make.fun — referral code 0txwmf1m
