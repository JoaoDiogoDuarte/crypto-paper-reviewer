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
- **Reads aloud**, phrase by phrase, highlighting the phrase; maths is read
  as words. Voices: the browser's, Kokoro and Piper (offline), Edge
  (unofficial endpoint), Azure and Google (official, need keys).

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+S` | save |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | undo, redo (structure edits included) |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+Shift+I` | `\textbf`, `\emph`, `\textit` |
| `$`, `Ctrl+M` | inline maths |
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
      "house_rules": {"tie_before": ["cite", "ref"], "flag_bracketed_cref": true},
      "key_style": "cryptobib",
      "bib_add_to": "references.bib",
      "build": ["latexmk", "-pdf", "-synctex=1", "main.tex"],
      "code_envs": ["ecblock"]
    }

## Setup

    python3 -m venv .venv
    .venv/bin/pip install edge-tts piper-tts kokoro-onnx soundfile   # voices (optional)
    .venv/bin/python get_voices.py                                   # Kokoro, Piper models (~700 MB)

Needs Python 3, a TeX installation with `latexmk`, `pdfcrop`, `pdftoppm` and
`pdftotext` (poppler), and Firefox or Chromium. KaTeX loads from jsDelivr.
Online voices send the text being read to Microsoft or Google.

## Tests

    node tests/roundtrip.js ~/papers         # every .tex parses and re-serializes byte for byte
    python3 -m unittest tests.backend_test   # save, build, document switching and launcher tests
    tests/selftest.py ~/papers/a ~/papers/b  # the page itself, in headless Firefox

`tests/selftest.py` with no arguments reads paths from `tests/papers.local`
(not tracked: keep your own papers out of the repository). In the browser,
`?selftest`, `?edittest` and `?uitest` run the same checks by hand.

## Conversion between venues

*Paper…* opens the metadata (read from the front matter of any class:
IEEEtran, llncs, iacrcc, iacrtrans, svjour3, acmart, LIPIcs, article;
your edits are kept in `.paper-editor/metadata.json`) and converts the
paper to another class: IEEEtran, llncs, iacrcc, iacrtrans, acmart,
LIPIcs or article, optionally anonymous. The form shows what the target
needs (an ORCID, a country, a licence, …). The result is a new main file
beside the old one, built at once; the section files are reused
unchanged. See `docs/styles.md` for what differs between the classes and
how the converter handles it, and `tests/convert_matrix.py`, which
converts the fixtures into every class and compiles the results (all 70
build, and no anonymous PDF shows an author name).

Anonymous versions use the class's own mechanism where there is one and
placeholders otherwise, drop acknowledgements from the main file and the
PDF's author field, and warn about acknowledgements, funding and `\thanks`
in other files: those, and self-citations in the first person, are yours
to check.

## Other features

Diff view against the last commit or the editor's start; a figure viewer
(double-click: image, extracted text, LaTeX) with a game editor for
algorithmicx and cryptocode pseudocode and a cell editor for tables; a
shortcut editor (`~/.config/paper-editor/keys.json`); a switcher between
the documents of a project folder.

## Not done yet

Springer Nature `sn-jnl` and `iacrj` targets (no class files to test
with), USENIX; a per-project dictionary.
