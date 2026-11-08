# paper-editor

> **This is 1000000% vibe-coded.** It was written by an AI assistant in a few
> long sessions, to my own taste, for my own papers (LaTeX, crypto, EasyCrypt
> listings, cryptobib). It works for me. It may not work for you, and it is not
> maintained as a product: no support, no stability promises, read the code
> before you trust it with anything. What it does guarantee is checked by
> tests (below): saving does not change text you did not edit.

A local reading editor for a LaTeX paper: the paper rendered as text with
typeset maths, edited in place, read aloud, and saved back to the `.tex`
sources, with the PDF rebuilt after each save.

The **Open…** button can choose a paper directory through the operating
system's folder picker and then lets you select which detected document is the
main file. The same project can contain several main documents.

    ./run ~/papers/my-paper              # a project folder (finds the main file)
    ./run ~/papers/my-paper/main.tex     # or the main file itself
    ./run paper --main other.tex --cwd .. --port 8766 [--browser chrome]

  It opens a standalone Chrome/Chromium app window by default and listens on
  127.0.0.1 only; use `--browser chrome` for a normal browser window,
  `--browser system` for the desktop's default browser, or `--no-open` to open
  the URL yourself. Writes need a token the page gets when it loads.

## What it does

- **Reads** the main file and everything it `\input`s, `\include`s or
  `\subfile`s, in document order. Numbers (sections, theorems, figures,
  equations, citations) come from the `.aux` LaTeX wrote, so they match the
  PDF for any class; macros come from the preamble (and local `.sty` files),
  theorem names from `\newtheorem`/`\declaretheorem`.
- **Edits in place.** Text is typed directly; maths, references, citations
  and other LaTeX are chips you click to edit, with a live preview.
- **Saves exactly.** Every block keeps its source; a save rewrites only the
  blocks you changed. Edited text follows house rules (configurable): LaTeX
  special characters escaped, `~` before `\cite`/`\ref`, `--`/`---` for
  dashes, ` `` '' ` quotes, bracketed `(\cref{…})` flagged.
- **Rebuilds the PDF** after saving (`latexmk -pdf -synctex=1` by default)
  and picks up the new numbers. Files changed on disk reload in the page; a
  save never overwrites a file that changed since it was read.
- **Pages**: page breaks from SyncTeX (exact) or estimated (marked ≈); in two
  columns each page is its own two-column box, as in the PDF, with `figure*`
  spanning both columns.
- **Cites and references by search**: the document's `.bib` files (indexed
  once; cryptobib's 90k entries search in ~40 ms) by key, title, author or
  year, or online (Crossref, arXiv) with the entry added to your `.bib`
  under a cryptobib-style key; every `\label` by number, type and text.
- **Find and replace**, toolbar, undo/redo for every kind of edit,
  light/dark/auto colours, one or two columns.
- Sections can be moved, combined, or split at the cursor. Existing `\input`
  files can be reviewed and edited in place.
- **Reads aloud**, phrase by phrase, highlighting the phrase; maths is read
  as words. Voices: the browser's, Kokoro and Piper (offline), Edge
  (unofficial endpoint), Azure and Google (official, need keys).

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+S` | save |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | undo, redo (structure edits included) |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+Shift+I` | `\textbf`, `\emph`, `\textit` |
| `$`, `Ctrl+M` | inline maths: the selection becomes a formula; with no selection, a new one |
| `(` `)` `[` `]` `{` `}` `"` `'` over a selection | wrap the selection (quotes become ` `` '' `) instead of replacing it |
| `Ctrl+Shift+M` | displayed equation at the cursor |
| `Enter` / `Backspace` at a paragraph's start | new paragraph / join with the one before |
| `Ctrl+Alt+1`, `2`, `3` | section, subsection, `\paragraph` heading at the cursor |
| `Ctrl+Alt+C`, `Ctrl+Alt+R` | cite, reference (search) |
| `Ctrl+\` | insert any LaTeX |
| `Ctrl+F`, `Ctrl+H` | find, find and replace |
| `Ctrl+A`, `Ctrl+E` | start, end of line (`Shift` selects) |
| `Ctrl+D`, `Alt+W`, `Ctrl+P` | delete line, cut region or line, duplicate region or line |
| `Ctrl++` | expand the selection: word, line, paragraph |
| `Alt+R` | read aloud from the cursor |
| `Alt+P` | pause or resume reading |
| `Alt+S` | stop reading |
| `Ctrl+Alt+Left`, `Ctrl+Alt+Right` | previous, next sentence |

Firefox reserves `Ctrl+W`, `Ctrl+Q`, `Ctrl+T`, `Ctrl+N` and
`Ctrl+Shift+R`. Spelling: right-click → *Add to Dictionary* (the browser's).

## Per-project settings

Everything about a paper lives in that paper's folder, in `.paper-editor/`:
`config.json` (optional, worth committing), and `cache/` (figure images,
bibliography index, audio; ignored by its own `.gitignore`). The editor's
folder holds only the program and the shared voice models.

    {
      "house_rules": {"tie_before": ["cite", "ref"], "flag_bracketed_cref": true, "one_sentence_per_line": false},
      "key_style": "cryptobib",
      "bib_add_to": "references.bib",
      "build": ["latexmk", "-pdf", "-synctex=1", "main.tex"],
      "code_envs": ["ecblock"]
    }

  When saving edited content, the editor asks before applying the configured
  house rules. Existing untouched content is preserved exactly; only edited
  blocks can be changed by those rules.
## Review workflow notes

- **New file** has been removed. Existing documents remain editable. **Diff**
  compares against the last save (unsaved edits) or the last Git commit and
  includes a clickable change minimap.
- **Metadata** is detected from the LaTeX source; nonmatching values are saved
  as overrides in `.paper-editor/metadata.json`. The dialog can restore the
  extracted values. Metadata edits do **not** rewrite the source `\author`.
- **Conversion** checks the required `.cls` first. Converted mains default to
  `converted/<venue>/` (the original folder can be chosen explicitly).
  Missing classes require installing their TeX packages separately. For LNCS,
  use Springer's official [llncs package](https://ctan.org/pkg/llncs), which
  includes `llncs.cls`, its documentation and the `splncs04.bst` bibliography
  style. The converter removes counter/theorem aliases for environments that
  the target class already defines (including LNCS `lemma`).
- **IACR class note:** the official [IACR LaTeX project](https://github.com/IACR/latex)
  says `iacrcc.cls` has been replaced by `iacrj.cls`; this editor's `iacrcc`
  conversion target remains a **legacy** option, not the current IACR template.
- **History** lets you delete an individual saved snapshot or clear all editor
  snapshots. This deletes only `.paper-editor/history` entries and unused blobs;
  it does not delete source files or Git commits.
- **Two-column mode** is a review reading flow: it groups source blocks into
  approximate spreads rather than copying PDF page boundaries from SyncTeX.
  Large figures and table images scale down to the reading-column width.
- **Game editor** opens by double-clicking a figure that contains `gameenv`
  or `algorithmic` blocks. Use Add to insert a statement, `if`, `while`,
  `for`, `repeat`, `return`, comment or assertion. Ordinary statements can
  move up/down; undo/redo of edits here are independent from whole-paper undo.
  Use Ctrl+Z / Ctrl+Shift+Z or the Undo/Redo buttons. Ctrl+Enter applies a
  draft; Ctrl+S applies then saves. Mark adds/removes `\\colorbox{...}{...}`
  with an existing `xcolor` package. Add/Copy/Delete and drag/Left/Right
  reorder complete `gameenv` blocks; moving across LaTeX layout wrappers is
  deliberately blocked so minipages and column breaks remain valid. An edit
  only reaches a `.tex` file after Apply, then Save.


## Debugging TeX builds

Start with `PAPER_EDITOR_DEBUG=1 ./run /path/to/paper` to keep the full
`latexmk` output, the main document's `.log`/`.aux`, and the temporary
`figs.tex`/`figs.log`/`figs.aux` in `<paper>/.paper-editor/debug/`.
Each build has its own timestamped directory. Debug data can contain paper
text; it is excluded from Git. Failed figure builds now print the TeX error
in the terminal. If a previous aborted build left an unreadable main `.aux`,
the editor keeps its old contents under `.paper-editor/cache/bad-aux/`,
then retries `latexmk -g` once. You should not run a second `latexmk` on the
same paper at the same time as the editor.

## Setup

    python3 -m venv .venv
    .venv/bin/pip install edge-tts piper-tts kokoro-onnx soundfile   # voices (optional)
    .venv/bin/python get_voices.py                                   # Kokoro, Piper models (~700 MB)

Needs Python 3, a TeX installation with `latexmk`, `pdfcrop`, `pdftoppm` and
`pdftotext` (poppler), and Firefox or Chromium. KaTeX loads from jsDelivr.
Online voices send the text being read to Microsoft or Google.

## Tests

    node tests/e2e.js                        # the page in headless Chrome: typing, keys, paste, saving, conflicts
    node tests/roundtrip.js ~/papers         # every .tex parses and re-serializes byte for byte
    python3 -m unittest tests.backend_test tests.test_convert_contract
    tests/selftest.py ~/papers/a ~/papers/b  # the page itself, in headless Firefox

`tests/e2e.js` (Node 22, Chrome or Chromium; `CHROME=…` to choose) runs a real
server on a throwaway paper and acts as a user: key presses, typing, pasting,
the dialogs, then compares the files on disk with what was typed. Pass words
to run only the tests whose names contain them (`node tests/e2e.js paste`).

Pasted text is plain text; formulas in it (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`)
become formulas. A copy from the page keeps its LaTeX for a paste back into
the page, and its plain text has the formulas as `$…$`.

`tests/selftest.py` with no arguments reads paths from `tests/papers.local`
(not tracked: keep your own papers out of the repository). In the browser,
`?selftest`, `?edittest` and `?uitest` run the same checks by hand.

## Torture and property testing

All torture tests use in-memory LaTeX, synthetic fixtures or temporary project
directories; **they never modify your manuscript**.

Quick tests (also run on each PR):

    python3 -m unittest tests.backend_test tests.test_convert_contract tests.torture_conversion
    node tests/roundtrip.js tests/fixtures
    node tests/torture.js --seeds=1,7,42,99 --cases=700
    E2E_SEEDS=17 E2E_OPS=18 node tests/e2e.js 'save torture:'

More intensive runs:

    TORTURE_CONVERSION_CASES=100 TORTURE_BACKEND_OPS=200 python3 -m unittest -v tests.backend_test tests.torture_conversion
    node tests/torture.js --seeds=1,7,42,99,2026,8192 --cases=2000
    E2E_SEEDS=1,2,3,4,17,31 E2E_OPS=100 node tests/e2e.js 'save torture:'
    node tests/e2e.js

The parser fuzzer generates valid and incomplete LaTeX and checks exact
token and segment round-trips, including accents, equations, tables and
games. A failure prints the seed, case and reproducing source. The metadata
fuzzer generates seven kinds of front matter and verifies titles, authors,
affiliations, keywords, abstract, running title and acknowledgements.
Conversion is tested for every destination class, normal and anonymous.
Backend tests use the real HTTP API: concurrent and repeated saves, stale
hashes, history, invalid paths, metadata JSON overrides, missing class
preflight, root/subdirectory output and overwrites. Browser fuzzing simulates
editing, undo, save conflicts and outside changes, printing the seed and
operation trace on a failure.

GitHub Actions > Torture tests (scheduled and manual) > Run workflow starts
the deep suite on demand. It also runs weekly (Sunday, 03:17 UTC), records
reproducible logs for 14 days and installs TeX to attempt real named and
anonymous IEEEtran/LNCS/article PDF conversions. The faster PR checks do not
claim to validate every venue PDF. Some less-common proprietary venue classes
must be installed separately; failures and omissions are reported explicitly.

## Conversion between venues

*Paper…* opens the metadata (read from the front matter of any class:
IEEEtran, llncs, iacrcc, iacrtrans, svjour3, acmart, LIPIcs, article;
your edits are kept in `.paper-editor/metadata.json`) and converts the
paper to another class: IEEEtran, llncs, iacrcc, iacrtrans, acmart,
LIPIcs or article, optionally anonymous. The form shows what the target
needs (an ORCID, a country, a licence, …). The result is a new main under `converted/<venue>/` by default (or beside the
original main if explicitly selected), built at once; the section files are
reused unchanged. See `docs/styles.md` for what differs between the classes and
how the converter handles it, and `tests/convert_matrix.py`, which
generates the venue variants for fixture-based testing. Builds still depend
on installed classes, packages and their versions.

Anonymous versions use the class's own mechanism where there is one and
placeholders otherwise, drop acknowledgements from the main file and the
PDF's author field, and warn about acknowledgements, funding and `\thanks`
in other files: those, and self-citations in the first person, are yours
to check.

## Other features

Diff view against the last save or the last commit; a figure viewer
(double-click: image, extracted text, LaTeX) with a game editor for
algorithmicx and cryptocode pseudocode and a cell editor for tables; a
shortcut editor (`~/.config/paper-editor/keys.json`); a switcher between
the documents of a project folder.

## Not done yet

Springer Nature `sn-jnl` and `iacrj` targets (no class files to test
with), USENIX; a per-project dictionary.
