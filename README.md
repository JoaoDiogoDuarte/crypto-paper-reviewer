# Crypto Paper Reviewer

> [!WARNING]
> **This project is vibe-coded: an AI coding assistant wrote practically all
> of the code, tests and documentation.** I steered it and used it on my own
> papers, but I did not review every line, so expect rough edges. It works
> for me; it may not work for you. No support, no stability promises. The
> one thing it is tested hard for: saving never changes text you did not
> edit. Keep your paper under Git (or another backup) anyway.

Review a LaTeX paper as the paper itself. Your `.tex` sources are shown as the
rendered paper, with typeset maths and the same numbers as the PDF. You fix
things in place, and each save writes back only what you changed, then
rebuilds the PDF. It is made for cryptography papers: security games and
pseudocode (cryptocode, algorithmicx), cryptobib citations, and conversion
between IACR, LNCS, IEEE, ACM and LIPIcs formats.

![A paper open for review](docs/screenshots/editor-light.png)

Type into the paper, make a phrase bold, save: the edit lands in
`sections/intro.tex` as `\textbf{rendered paper}` and the PDF rebuilds.

![Editing a sentence in place, then saving](docs/screenshots/editing.gif)

More in **[the demos](docs/demos.md)**: maths, citations and references,
the game and table editors, diff, outside changes and venue conversion.

<details><summary>Dark theme</summary>

![The same paper in the dark theme](docs/screenshots/editor-dark.png)

</details>

## Install

You need Python 3, a TeX installation with `latexmk` (and `pdfcrop`,
`pdftoppm`, `pdftotext` from poppler), and Chrome, Chromium or Firefox.

    git clone https://github.com/JoaoDiogoDuarte/paper-editor.git
    cd paper-editor

That is enough to start. Reading aloud with offline voices is optional:

    python3 -m venv .venv
    .venv/bin/pip install edge-tts piper-tts kokoro-onnx soundfile
    .venv/bin/python get_voices.py        # downloads ~700 MB of voice models

## Use

    ./run ~/papers/my-paper              # a paper folder (finds the main file)
    ./run ~/papers/my-paper/main.tex     # or a main file

It opens in its own browser window and is reachable only from your machine
(it listens on `127.0.0.1` and refuses requests addressed to any other host).
**Open…** switches to another paper or another main file in the same folder.
Stop it with `Ctrl+C` in the terminal.

| Option | Meaning |
| --- | --- |
| `--main other.tex` | the main file, when the folder has several documents |
| `--browser chrome-app` | Chrome or Chromium as an app window (the default) |
| `--browser chrome` | Chrome or Chromium as a normal window |
| `--browser system` | your default browser (Firefox works) |
| `--no-open` | open nothing; visit `http://127.0.0.1:8765/` yourself |
| `--port 8766` | another port (the default is 8765) |
| `--cwd DIR` | the directory LaTeX runs in (default: the main file's) |
| `--state DIR` | where settings, history and caches go (default: `<paper>/.paper-editor`) |

## What it does

- **Read the paper, not the source**, with section, theorem, equation and
  citation numbers taken from LaTeX's own `.aux`, so they match the PDF.
  Light or dark theme, one or two columns, overfull boxes marked, read aloud.
- **Fix text in place.** Maths, references and citations are chips you click
  to edit with a live preview; cite by searching your `.bib`, Crossref or
  arXiv; reference by searching labels.
- **Edit games and tables.** Double-click a `gameenv` or `algorithmic`
  figure to edit it line by line, or a table to edit it cell by cell.
- **Save exactly.** Only the blocks you changed are written back. **Diff**,
  **History** and change bars show what you did; outside changes to the
  files are picked up.
- **Convert to another venue**: IEEEtran, llncs, iacrcc, iacrtrans, acmart,
  LIPIcs or article, optionally anonymous.

The **[guide](docs/guide.md)** has the intended workflow, every feature, the
keys, per-paper settings, the voices for reading aloud and how venue
conversion works.

## Development

Tests and how to debug TeX builds are in
[docs/development.md](docs/development.md).

## License

[MIT No Attribution](LICENSE): do anything with it, no notice required.
