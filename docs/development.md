# Development

Crypto Paper Reviewer is a small Python server (`server.py`, `convert.py`) and
a single page (`static/`). It has no build step and no dependencies beyond
Python 3, Node 22 for the tests, and Chrome or Chromium for the browser tests.

## Tests

    node tests/e2e.js                        # the page in headless Chrome: typing, keys, paste, saving, conflicts
    node tests/roundtrip.js ~/papers         # every .tex parses and re-serializes byte for byte
    python3 -m unittest tests.backend_test tests.test_convert_contract
    tests/selftest.py ~/papers/a ~/papers/b  # the page itself, in headless Firefox
    node tests/ui_torture.js [--real]        # bug bounty: every feature on real papers, checked on screen
    python3 -m unittest tests.test_convert_roundtrip   # S -> A -> S and S -> A -> B -> S give S byte for byte

`tests/e2e.js` (`CHROME=…` to choose the browser) runs a real server on a
throwaway paper and acts as a user: key presses, typing, pasting, the dialogs.
Then it compares the files on disk with what was typed. Pass words to run only
the tests whose names contain them (`node tests/e2e.js paste`).

`tests/selftest.py` with no arguments reads paths from `tests/papers.local`
(not tracked: keep your own papers out of the repository). In the browser,
`?selftest`, `?edittest` and `?uitest` run the same checks by hand.

## Torture and property tests

All torture tests use in-memory LaTeX, synthetic fixtures or temporary project
directories; **they never modify your manuscript**.

Quick:

    python3 -m unittest tests.backend_test tests.test_convert_contract tests.torture_conversion
    node tests/roundtrip.js tests/fixtures
    node tests/torture.js --seeds=1,7,42,99 --cases=700
    E2E_SEEDS=17 E2E_OPS=18 node tests/e2e.js 'save torture:'

Intensive:

    TORTURE_CONVERSION_CASES=100 TORTURE_BACKEND_OPS=200 python3 -m unittest -v tests.backend_test tests.torture_conversion
    node tests/torture.js --seeds=1,7,42,99,2026,8192 --cases=2000
    E2E_SEEDS=1,2,3,4,17,31 E2E_OPS=100 node tests/e2e.js 'save torture:'
    node tests/e2e.js

The parser fuzzer generates valid and incomplete LaTeX. It checks exact token
and segment round trips, including accents, equations, tables and games. A
failure prints the seed, the case and the source that reproduces it. The
metadata fuzzer generates seven kinds of front matter and checks titles,
authors, affiliations, keywords, abstract, running title and
acknowledgements. Conversion is tested for every target class, named and
anonymous. Backend tests use the real HTTP API: concurrent and repeated saves,
stale hashes, history, invalid paths, metadata overrides, missing classes,
output folders and overwrites. Browser fuzzing simulates editing, undo, save
conflicts and outside changes, and prints the seed and operation trace on a
failure.

## CI

Two workflows. Both are currently disabled on GitHub (`gh workflow enable
smoke.yml` / `torture.yml` turns them back on).

- **CI** (`smoke.yml`) is the fast gate on every PR and push to main: syntax
  checks, backend and conversion tests, seeded LaTeX round trips and a
  browser smoke subset, in about a minute. A newer push to a PR cancels the
  older run.
- **Deep torture** (`torture.yml`) runs weekly (Sunday, 03:17 UTC) and from
  Actions > Deep torture > Run workflow. Pushes do not trigger it, so run it
  by hand before merging risky test-harness or fixture changes. It runs every
  campaign even when one fails, keeps logs for 14 days, and installs TeX to
  build real named and anonymous IEEEtran/LNCS/article conversions. Some
  less common venue classes must be installed separately; failures and
  omissions are reported explicitly.

## Debugging TeX builds

`PAPER_EDITOR_DEBUG=1 ./run /path/to/paper` keeps the full `latexmk` output,
the main document's `.log`/`.aux`, and the temporary `figs.tex`/`figs.log`/
`figs.aux` in `<paper>/.paper-editor/debug/`, one timestamped folder per
build. Debug data can contain paper text and is excluded from Git. Failed
figure builds print the TeX error in the terminal. If an aborted build left an
unreadable main `.aux`, the editor keeps its old contents under
`.paper-editor/cache/bad-aux/` and retries `latexmk -g` once. Do not run a
second `latexmk` on the same paper while the editor is running.

## Internals worth knowing

- History snapshots live in `.paper-editor/history`. Deleting one, or
  clearing them all, never touches source files or Git commits.
- Two-column mode is a reading flow: it groups source blocks into
  approximate spreads instead of copying the PDF's page breaks.
- The game editor blocks moves across LaTeX layout wrappers so minipages and
  column breaks stay valid. Its undo history is separate from the paper's.
- `tests/convert_matrix.py` generates the venue variants used by the
  fixture-based conversion tests.
- The README screenshots and editing GIF were recorded by driving headless
  Chrome over a built copy of `tests/fixtures/ieee-conf`.
