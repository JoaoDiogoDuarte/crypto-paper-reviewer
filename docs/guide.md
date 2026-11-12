# Guide

How to use Crypto Paper Reviewer in detail. Installing and starting it are
in the [README](../README.md); recorded examples are in the [demos](demos.md).

## Intended workflow

The editor is for the **reviewing and polishing** stage: the paper exists,
builds, and you want to read it as a reader would and fix what you find,
without hunting for the line in the source. It is not a replacement for your
text editor for writing the preamble, macros or new figures from scratch.

1. **Keep the paper in Git** and commit before a session. The editor never
   touches text you did not edit, but Git is your real safety net, and
   **Diff** can compare with the last commit.
2. **Build the paper once** the usual way if it has no `.aux` yet: numbers
   for sections, equations and citations are read from it, so they match the
   PDF. Then **start the editor** on the paper folder
   (`./run ~/papers/my-paper`); it renders the figures and opens the page.
3. **Read through the rendered paper.** Turn on two columns or read it
   aloud (listening catches errors your eyes skip). Overfull and underfull
   boxes are marked on the blocks that cause them.
4. **Fix things in place**: typos, wording, a missing citation
   (`Ctrl+Alt+C`), a reference (`Ctrl+Alt+R`), a formula (click it), a
   game or table (double-click the figure).
5. **Save** (`Ctrl+S`). Only the blocks you changed are written back, to the
   file they came from; house rules are offered first; the PDF rebuilds in
   the background.
6. **Check what you did** with **Diff** (since the last save or the last
   commit), then commit in Git as usual. **History** has every save if you
   need to go back.
7. **For a submission elsewhere**, use **Paper…** to convert to the target
   venue (optionally anonymous). The result goes in `converted/<venue>/`
   and reuses your section files, so later fixes apply to every version.

You can keep your usual editor open at the same time: when a file changes on
disk the paper reloads, and if you had unsaved edits in that file you choose
what happens (see *Outside changes* below). Do not run a second `latexmk` on
the same paper while the editor is building.

## What you can do

### Read

The header bar holds back and forward, the title, **Save**, **Read**, **PDF**
and the ☰ menu (open, history, reload, build, text size, columns, theme,
colour-blind colours, paper metadata, keys, help). The editing toolbar keeps
to one row: headings are under **Heading**, and what does not fit goes
under ⋯. In narrow windows both show icons only; hovering a button names it.

- **The paper, not the source.** Everything the main file `\input`s or
  `\include`s, in order, with section, theorem, equation and citation
  numbers taken from LaTeX's own `.aux`, so they match the PDF. Page breaks
  follow the PDF. Figures, tables and games are shown as images cut from a
  build of their own; natbib, biblatex and hand-written `thebibliography`
  reference lists are rendered. `quote` and `quotation` environments are
  shown as indented block quotes, and are edited in place like paragraphs.
- **Layout.** Light, dark or follow-the-system theme; one or two columns;
  a colour-blind friendly mode for change and mark colours. **A−** / **A+**
  change the size of the paper's text without changing the toolbar (click
  the percentage to reset).
- **Follow references.** `Ctrl`+click (`Cmd`+click) a reference or a
  citation to go to Lemma 4, the equation, the figure or the reference
  entry. The ← and → buttons at the left of the header bar (or `Alt+←`,
  `Alt+→`, or the mouse's back and forward buttons) go back and forward
  over every jump: a reference, a box warning, a change of the diff, a find
  match.
- **Build problems.** Overfull and underfull boxes from the `.log` are shown
  as badges on the blocks they come from. The toolbar shows the build state;
  **PDF** opens the latest PDF; in the ☰ menu, **Build the PDF now** builds
  again, and **Clean build**
  sets the `.aux`, `.bbl` and other build files aside (in the editor's
  cache) and builds from scratch, which fixes a damaged `.aux`. A build
  that stops on a truncated `.aux` is retried once without it.
- **Listen.** Read aloud from the sentence at the cursor, phrase by phrase,
  with the phrase highlighted and maths read as words; while reading, Prev and Next move by
  sentence; speed and voice are under the ▾ beside **Read**, which stays tinted while
  reading. Edits are read as they are now (a phrase edited while paused is
  read again from its start on resume), and a save does not interrupt the
  phrase being read. See *Reading aloud* below for the voices.

### Edit

- **Text.** Type directly. `Enter` starts a new paragraph, `Backspace` at
  the start of one joins it to the previous one. Bold, emphasis and italic
  from the toolbar or keys. Paste plain text; formulas in it (`$…$`,
  `\[…\]`) become formulas, and Unicode maths symbols are written as LaTeX
  for pdfLaTeX papers.
- **Chips.** Maths, references, citations and any LaTeX the editor does not
  render are grey *chips*: click one to edit its source with a live preview
  (`Ctrl+Enter` applies). `Ctrl+\` inserts any LaTeX.
- **Structure.** Add a section, subsection or `\paragraph` heading at the
  cursor; hover a block and use **＋** to add a paragraph, heading or
  displayed equation after it, or **✕** to delete a heading. Heading tools
  move a section up or down or merge it with the previous one; **Split
  section** divides the current one at the cursor. Undo brings a deleted or
  merged heading back and warns about references to it.
- **Cite and reference by searching.** Search your `.bib` files by key,
  title, author or year (cryptobib's 90k entries take about 40 ms), or
  Crossref and arXiv, which add the entry to your `.bib` with a
  cryptobib-style key (`C:BelRog93`). `Ctrl+Enter` picks several. Search
  labels by number, type or text.
- **Games and pseudocode.** Double-click a figure with `gameenv` (cryptocode)
  or `algorithmic` pseudocode. The figure viewer has tabs: **Image**, **Text**
  (the text extracted from the rendered figure),
  **Games** (line by line: insert `if`, `while`, `for`, `return` and
  comments, move statements with `Alt+Up/Down`, colour lines with xcolor
  boxes, add games, and arrange them in a grid: choose 1–4 columns, then
  drag a game, or use its arrows, into any cell; a cell can hold several
  games one under the other. The grid is written as top-aligned minipages,
  and a `multicols` wrapper such as `\begin{games}{2}` is set to one
  column), **LaTeX** (the raw source) and **Changes**.
  **Apply** (`Ctrl+Enter`) puts the change into the paper; `Ctrl+S` applies
  and saves.
- **Tables.** Double-click a table to edit it cell by cell (**Cells** tab).
  `\verb`, nested tabulars and comments in cells stay whole.
- **Code listings** (`lstlisting`, `minted`, `verbatim` and the
  environments in `code_envs`) are edited in their box.
- **Find and replace** (`Ctrl+F`, `Ctrl+H`) in the text, with regular
  expressions, case and whole-word options; it says what it replaced, and
  undo takes it back. Maths and chips are not searched.
- **Undo and redo** across everything above, and spelling suggestions from
  the browser (right-click).

### Save and review

- **Saving is exact.** Only the blocks you changed are rewritten, in the
  file they came from; the file's permissions are kept and the write is
  atomic. Edited text follows *house rules* you can configure (special
  characters escaped, `~` before `\cite`/`\ref`, `--`/`---` dashes,
  ` `` '' ` quotes, optionally one sentence per line); the editor asks before
  applying them. A failed save keeps your edits on the page.
- **Change bars.** Edited blocks get a bar in the margin; hover it to see
  the change and **Revert** that block alone.
- **Diff** shows every change since the last save or the last Git commit
  (read-only while it is on), with previous/next buttons.
- **History** lists every save, each keeping the text it replaced, and can
  restore one. You can delete one snapshot or clear them all (Git commits are
  never touched).
- **Outside changes.** If a file changes on disk (another editor,
  `git pull`) the paper reloads. If you had unsaved edits in that file, you
  choose: **Reload** (take theirs), **Overwrite disk** (keep yours; theirs is
  kept in History), **Save backup** (your version goes to a `name.tex.editor-backup-…` file
  beside it, then theirs is loaded) or **Later**. A save never overwrites a
  file that changed since it was read. **Reload from disk** in the ☰ menu rereads
  everything and asks before dropping your edits.

### Convert

- **Paper…** shows the detected title, authors, affiliations, keywords and
  abstract, lets you correct them, and converts the paper to IEEEtran,
  llncs, iacrcc, iacrtrans, acmart, LIPIcs or article, optionally anonymous.
  See [Converting between venues](#converting-between-venues).

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+S` | save |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | undo, redo |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+Shift+I` | bold, emphasis, italic |
| `Ctrl+M` | inline maths: a new formula, or the selection becomes one (`$` typed over a selection does the same; otherwise `$` is a dollar sign) |
| `Ctrl+Shift+M` | displayed equation |
| `(` `)` `[` `]` `{` `}` `"` `'` over a selection | wrap the selection |
| `Enter` / `Backspace` at a paragraph's start | new paragraph / join paragraphs |
| `Ctrl+Alt+1`, `2`, `3` | section, subsection, paragraph heading |
| `Ctrl+Alt+C`, `Ctrl+Alt+R` | cite, reference |
| `Ctrl+\` | insert any LaTeX |
| `Ctrl+F`, `Ctrl+H` | find, find and replace |
| `Ctrl+A`, `Ctrl+E` | start, end of line (`Shift` selects) |
| `Ctrl+D`, `Alt+W`, `Ctrl+P` | delete line, cut, duplicate |
| `Ctrl++` | expand the selection: word, line, paragraph |
| `Alt+R`, `Alt+P`, `Alt+S` | read aloud, pause, stop |
| `Ctrl+Alt+Left`, `Ctrl+Alt+Right` | previous, next sentence |
| `Ctrl+Alt+S` | split the section at the cursor |
| `Ctrl+Alt+A` | add a block after the one at the cursor |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | move the section at the cursor up / down |
| `Ctrl+Alt+J` | combine the section at the cursor with the previous one |
| `Ctrl+Alt+X` | delete the heading at the cursor |
| `Ctrl+Alt+Backspace` | revert the block at the cursor to the last save |
| `Ctrl+Alt+F` | open the figure or table at the cursor in the viewer |
| `Ctrl`+click a reference or citation, `Alt+←`, `Alt+→` | go to what it names, back, forward |

Everything in the bars and the ☰ menu has a key too (all `Ctrl+Alt+…`, and all
listed and changeable under **Keys…**):

| Key | Action |
| --- | --- |
| `Ctrl+Alt+M` | the ☰ menu |
| `Ctrl+Alt+O` / `Ctrl+Alt+T` / `Ctrl+Alt+L` | open a paper, save history, reload from disk |
| `Ctrl+Alt+B` / `Ctrl+Alt+Shift+B` | build the PDF now, clean build |
| `Ctrl+Alt+D` | open the rendered PDF |
| `Ctrl+Alt+P` / `Ctrl+Alt+,` / `Ctrl+Alt+H` | paper metadata and conversion, keys, help |
| `Ctrl+Alt+G` / `Ctrl+Alt+W` | colour scheme, one or two columns |
| `Ctrl+Alt+-` / `Ctrl+Alt+=` / `Ctrl+Alt+0` | smaller, larger, reset paper text size |
| `Ctrl+Alt+V`, then `Ctrl+Alt+[` / `Ctrl+Alt+]` | diff of what changed, previous / next change |
| `Ctrl+Alt+U` | reading speed and voice |

While a dialog is open its own keys work: the outside-change bar answers
`r` (reload), `o` (overwrite disk), `b` (save backup), `l` (later); `Enter`
confirms the open dialog; in the figure viewer `1`–`6` pick the tabs.

**Keys…** in the ☰ menu changes them. In the game editor, `Ctrl+Enter`
applies and `Ctrl+S` applies and saves. Spelling: right-click, *Add to
Dictionary*.

## Settings for a paper

Each paper keeps its settings, save history and caches in its own
`.paper-editor/` folder (add `.paper-editor/` to the paper's `.gitignore`,
except perhaps `config.json`). The configuration is optional; it is read
from `.paper-editor.json` next to the main file, then
`.paper-editor/config.json`, and these are the defaults:

    {
      "house_rules": {"tie_before": ["cite", "ref"], "flag_bracketed_cref": true, "one_sentence_per_line": false},
      "key_style": "cryptobib",
      "bib_add_to": null,
      "build": null,
      "code_envs": ["ecblock"]
    }

| Key | Meaning |
| --- | --- |
| `house_rules.tie_before` | commands that get a `~` before them in edited text |
| `house_rules.flag_bracketed_cref` | warn about `(\cref{…})`: refer in prose instead |
| `house_rules.one_sentence_per_line` | break edited paragraphs after each sentence |
| `key_style` | key style for entries added from Crossref or arXiv |
| `bib_add_to` | the `.bib` file that receives them (default: the smallest one the paper uses) |
| `build` | the build command, run in the main file's directory (default: `make` if there is a `Makefile`, otherwise `latexmk -pdf -synctex=1`) |
| `code_envs` | more environments to show as editable code boxes |

Metadata you correct in **Paper…** is kept in `.paper-editor/metadata.json`,
with earlier versions. It never rewrites your `\author` lines.

Your key bindings (**Keys…** in the ☰ menu) are shared by every paper and
kept in `~/.config/paper-editor/keys.json`.

## Reading aloud

The browser's own voices always work. The others are optional:

| Voice | Needs | Text leaves your machine? |
| --- | --- | --- |
| Kokoro, Piper | `.venv` with `kokoro-onnx`, `piper-tts`, `soundfile`, then `get_voices.py` | no |
| Edge | `edge-tts` in `.venv` | yes, to Microsoft |
| Azure | `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in the environment | yes, to Microsoft |
| Google | `GOOGLE_TTS_API_KEY` in the environment | yes, to Google |

`./run` uses `.venv` automatically when it exists.

## Converting between venues

**Paper…** reads the front matter of IEEEtran, llncs, iacrcc, iacrtrans,
svjour3, acmart, LIPIcs and article papers. It shows what the target class
needs (an ORCID, a country, a licence, …) and writes a new main file under
`converted/<venue>/`, built at once; your section files are reused
unchanged. [styles.md](styles.md) explains what differs between
the classes.

- **Anonymous versions** use the class's own mechanism where there is one,
  drop acknowledgements and the PDF author field, and warn about
  acknowledgements, funding and `\thanks` in other files. Self-citations in
  the first person are yours to check.
- **Class files** that TeX Live does not ship (`iacrcc`, `iacrtrans`,
  `lipics-v2021`, `svjour3`, Springer Nature's `sn-jnl`, with their
  `.bst`/`.clo` files) are bundled in `classes/`. Others must be installed;
  for LNCS use Springer's [llncs package](https://ctan.org/pkg/llncs) (it
  includes `splncs04.bst`).
- **Round trips.** A converted file remembers the file it came from.
  Converting it back gives the original byte for byte, with your edits to
  the converted text carried over; converting it to a third venue starts
  from the original, so no compatibility shims pile up.
- **IACR:** `iacrcc` is a legacy target. IACR now recommends
  [`iacrj.cls`](https://github.com/IACR/latex), which is not supported yet.

## Not done yet

Springer Nature `sn-jnl`, `iacrj` and USENIX targets; a per-paper dictionary.
