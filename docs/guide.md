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
   With no folder given it starts on the list of recent papers (the last
   one is loaded behind it, so `Esc` goes on with it). **Open…** (`Ctrl+O`)
   shows the same list (a click or the paper's number, `1`–`9`, opens one).
   The × beside a paper, or `Delete` on it, takes it off the list. Its files
   stay where they are.
   **Open a folder…** chooses a paper's folder with the desktop's own
   dialog (zenity or kdialog on Linux); a folder with several documents
   shows an **Open …** button for each.
   **New paper…** makes a folder with `main.tex` for a venue (the classes of
   *Convert*), `sections/01-introduction.tex` and `02-conclusion.tex`, and
   `references.bib`. **Anonymous** sets `\anontrue` in `main.tex`: one
   `\ifanon` switch near the top gives the anonymous or the named version,
   with the class options the venue needs. cryptobib can be added as a Git
   submodule (in a new repository with a `.gitignore` for the build files,
   or in the repository the folder is in), as a plain clone, or not at all;
   the bibliography then reads `cryptobib/abbrev3`, `cryptobib/crypto` and
   `references`. Title, authors, keywords and abstract are optional, and
   can be filled in later in **Paper…**.
   When the editor's own code changes (an update, a `git pull`), the page
   reloads itself at a pause and comes back where it was: the view, the
   cursor, unsaved edits, the source view, the find bar, the diff. A change
   to `server.py` restarts the server in place (same port and paper; never
   during a build; code that does not compile is not started).
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
  follow the PDF: from SyncTeX when the build writes it, otherwise (a
  `Makefile` build without `-synctex`) by finding each block's text in the
  PDF's text. Figures, tables and games are shown as images cut from a
  build of their own; natbib, biblatex and hand-written `thebibliography`
  reference lists are rendered. `quote` and `quotation` environments are
  shown as indented block quotes, and are edited in place like paragraphs.
- **Structure.** **Show structure** in the ☰ menu (`Ctrl+Alt+I`) marks where
  every environment starts and ends (`▸ abstract` … `abstract ◂`, itemize,
  theorems, proofs) and shows each `\label` as a small tag.
- **Word count.** Beside the file name: the words of the text, headings and
  captions (an inline formula counts as one word, citations as none); with a
  selection, how many of them are selected.
- **Layout.** Light, dark or follow-the-system theme; one or two columns;
  a colour-blind friendly mode for change and mark colours. **A−** / **A+**
  change the size of the paper's text without changing the toolbar (click
  the percentage to reset), and **Width** sets how wide the paper is in one
  column. The text size, width, columns and what the diff compares with are
  kept for each paper, and a paper opened for the first time starts with the
  last ones chosen.
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
- **Listen.** Read aloud from the sentence at the cursor (or the start of the
  selection), phrase by phrase, with the phrase highlighted and maths read as
  words; with nothing selected or clicked it starts at the top of the paper.
  While reading, Prev and Next move by sentence; the ▾ beside **Read** also has
  **Read from here** (the cursor, or the last place clicked), **Read from
  section start** and **Read from the beginning**. Speed (a slider from
  0.5× to 2× in steps of 0.05, e.g. 1.1×) and voice are under the
  same ▾, which stays tinted while
  reading. Edits are read as they are now (a phrase edited while paused is
  read again from its start on resume), and a save does not interrupt the
  phrase being read. See *Reading aloud* below for the voices.

### Edit

- **Toolbar.** Bold, emphasis, typewriter; inline and displayed maths; cite,
  reference, footnote, any LaTeX; headings; bulleted and numbered lists (of
  the selected sentences, or a new one, edited in place); find; source view,
  structure, diff; undo and redo. What does not fit goes under ⋯.
- **Text.** Type directly. `Enter` starts a new paragraph, `Backspace` at
  the start of one joins it to the previous one. Bold, emphasis and italic
  from the toolbar or keys. Paste plain text; formulas in it (`$…$`,
  `\[…\]`) become formulas, and Unicode maths symbols are written as LaTeX
  for pdfLaTeX papers. Zero-width spaces and byte-order marks that come
  with text copied from web pages are dropped (pdfLaTeX stops at them).
- **Selecting across paragraphs.** Drag, `Shift`+click or `Shift`+arrows go on
  from one paragraph into the next. Such a selection can be copied (text and
  LaTeX), cut, deleted or typed over: the blocks between go and the first
  and last are joined, in one undo step. Formatting (`Ctrl+B`, `$`, a
  bracket) works inside one paragraph.
- **Source view.** **Source** in the toolbar (`Ctrl+Alt+E`) shows the `.tex`
  and `.bib` files of the folder with line numbers and colours, at the line
  of the block the cursor was in; a list on the left switches files (the
  document's own, other `.tex` files, the bibliographies). A file of the
  document edited there is the same text as the paper view; other files are
  saved with `Ctrl+S` like the rest. `Esc` or **Back to the paper** returns
  to the block of the current line. **Wrap** (on by default) wraps long
  lines; the line numbers follow. **Open in your editor** (`Ctrl+Alt+Z`,
  also in the paper, at the block of the cursor) opens the file at the
  cursor's line in your own editor (`external_editor` below; Emacs by
  default). **Preview only** makes the view read only: you edit in your
  editor, and the view follows the files on disk, scrolled to a change
  made off screen. The view opens at the place the paper shows (the
  cursor's block, or the block at the top) and goes back to the place it
  shows, each line where its block was on the screen. Very large files (cryptobib's
  `crypto.bib`) show their first 2 MB, read only.
  A bar beside the line numbers marks the lines changed since the last save
  (green added, orange changed, a red notch where lines were taken out);
  **Go to…** lists the file's headings (or a `.bib`'s entries) to jump to;
  `Ctrl+G` (or a click on the line and column) goes to a line; `Ctrl+/`
  comments the region out with `%` or back in; a bracket or `$` typed over a
  selection wraps it.
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
  boxes, put lines in algpseudocodex boxes (`\BeginBox[gbox=one]`) or take
  them out, click the edge of a box to restyle, grow, shrink or remove it,
  edit a line's comment in place, `Enter` for a new statement, `Backspace`
  on an empty line or `Ctrl+Shift+K` to delete a line (a whole block from
  its first or last line), add games, and arrange them in a grid: choose 1–4 columns, then
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
- **Files, one section per file.** **To file** in a heading's tools
  (`Ctrl+Alt+Y`) moves a section into `sections/<label or title>.tex`
  (beside the main file), read with `\input` where it was. **☰ → Files…**
  (`Ctrl+Alt+N`) does it for every section at once (**One file per
  section**), makes a new section file or an empty file, adds images, and
  lists the document's files with **Go**, **Source**, **Rename…** (every
  `\input` of it is updated), **Inline** (its text goes back where it is
  read) and, for files the document does not read, **Include** and
  **Trash** (to `.paper-editor/trash`). The first block of each file shows
  its name in its tools, with the same menu. When the sections live in
  `sections/`, a section split off or added inside one gets a file of its
  own, and **Up**/**Down** move whole section files. New files are written
  when you save (a new `new-section.tex` is named after its title then);
  Undo takes them out, and a new file nothing reads is never written.
- **Images.** Drop or paste an image into the text, or use **Figure from an
  image…** in a block's **+** menu: it is copied to `figures/` and placed in
  a figure after that block (the editor offers to load `graphicx` if the
  paper does not).
- **Listings from files.** `\lstinputlisting` and the paper's macros around
  it (such as `\ecsnippet{File.ec}{name}`, which reads the range between
  `(*> name *)` and `(*< name *)`) show the code itself, highlighted with the
  paper's `\lstdefinelanguage`; **LaTeX** in the block's tools shows the
  command. Files may be anywhere in the project's Git work tree.

### Save and review

- **Saving is exact.** Only the blocks you changed are rewritten, in the
  file they came from; the file's permissions are kept and the write is
  atomic. Edited text follows *house rules* you can configure (special
  characters escaped, `~` before `\cite`/`\ref`, `--`/`---` dashes,
  ` `` '' ` quotes, optionally one sentence per line); the editor asks before
  applying them. A failed save keeps your edits on the page.
- **Change bars.** Edited blocks get a bar in the margin; hover it to see
  the change and **Revert** that block alone.
- **Diff** shows every change since the last save, since the editor opened,
  since the last Git commit, or since **any earlier commit** of the paper's
  folder, with previous/next buttons and a map of the changes beside the
  scroll bar. A click on a block edits it there: that block is drawn as
  usual, and its changes are drawn again when you leave it (`Esc`, or a
  click outside the text). Saving and undo keep the diff open. **Revert** on a change (or
  `Ctrl+Alt+Backspace` on the current one) puts that block back as it was
  in the version compared with; Undo brings the change back. After a commit
  made outside the editor, the reload button beside **Next** reads the
  commits again and recomputes the diff.
- **Unsaved edits survive a crash.** Every few seconds the edited files are
  kept in the browser; if the page closes or crashes before you save, the
  paper offers them back when it opens (**Restore** / **Discard**). A file
  that changed on disk since is restored against the version it started
  from, so saving it asks first instead of overwriting the other version.
- **Report a problem** (☰ menu, `Ctrl+Alt+Q`): type a line about what went
  wrong; the last 10 minutes of what you pressed and clicked, what the
  editor did (draws, saves, builds, messages, errors) and every scroll with
  its cause (one nobody asked for is marked as a jump) are written to
  `.paper-editor/debug/report-<time>.jsonl` with the end of the LaTeX log.
  The running record is `.paper-editor/debug/trace.jsonl`. Typed text is not
  kept, only how much was typed, and nothing leaves your machine.
- **House-rule warnings** (a bracketed `\cref`, say) come with **Show**,
  which steps through every block where the rule holds, and **Don't warn
  again**. Every message under the bars closes with its × or `Esc`.
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

### Accessibility

- Every bar, panel and dialog closes with its × (top right) or `Esc`; focus
  moves into a dialog when it opens, `Tab` stays inside it, and focus comes
  back where it was when it closes.
- A **Skip to the paper** link comes first; the paper is a labelled region.
- `Alt+↓`/`Alt+↑` move the cursor to the next or previous block,
  `Ctrl+Alt+PageDown`/`PageUp` to the next or previous heading; screen
  readers hear which block it is.
- With *reduce motion* set in the system, nothing glides or animates; in
  forced colours (high contrast), chips, change bars, diff marks and the
  reading highlight are drawn with system colours; on touch screens the
  block tools always show and buttons are larger.

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
| `Ctrl+D`, `Alt+W`, `Ctrl+W`, `Ctrl+P` | delete line, cut / copy the region or the line, duplicate (Emacs style; browsers may keep `Ctrl+W` for themselves) |
| `Ctrl+Q`, `Ctrl+Backspace` | delete the character before, delete back to the previous space |
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

In the source view the same Emacs-style keys edit the text as in a code
editor: `Ctrl+A` / `Ctrl+E` (start or end of the code on the line, then of
the line; `Shift` selects), `Ctrl+D` delete line, `Ctrl+P` duplicate,
`Ctrl+W` / `Alt+W` copy / cut the region or the line, `Ctrl+Q`,
`Ctrl+Backspace`, `Tab` / `Shift+Tab` indent / unindent, `Enter` keeps the
indentation; `Ctrl+Z` is the text's own undo. All of them are under **Keys…**.

Everything in the bars and the ☰ menu has a key too (all `Ctrl+Alt+…`, and all
listed and changeable under **Keys…**):

| Key | Action |
| --- | --- |
| `Ctrl+Alt+M` | the ☰ menu |
| `Ctrl+O` (or `Ctrl+Alt+O`) / `Ctrl+Alt+T` / `Ctrl+Alt+L` | open a paper, save history, reload from disk |
| `Ctrl+Alt+E` / `Ctrl+Alt+I` | source view, show structure |
| `Ctrl+Alt+Z` | open the file at the cursor's line in your own editor |
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
`.paper-editor/config.json` (a file that sets some house rules keeps the
defaults of the others), and these are the defaults:

    {
      "house_rules": {"tie_before": ["cite", "ref"], "flag_bracketed_cref": true, "one_sentence_per_line": false},
      "key_style": "cryptobib",
      "bib_add_to": null,
      "build": null,
      "code_envs": ["ecblock"],
      "external_editor": null
    }

| Key | Meaning |
| --- | --- |
| `house_rules.tie_before` | commands that get a `~` before them in edited text |
| `house_rules.flag_bracketed_cref` | warn about `(\cref{…})`: refer in prose instead |
| `house_rules.one_sentence_per_line` | put each sentence of a changed line on a line of its own (on in papers made with **New paper…**, which write it to `.paper-editor.json`); lines you did not change keep their layout, and maths, comments, `\verb`, `\url`, `\footnote`, tables and pictures are never split |
| `house_rules.abbreviations` | abbreviations of the paper whose period never ends a sentence, such as `["Constr."]`, besides the built-in list (`e.g.`, `i.e.`, `cf.`, `et al.`, `Fig.`, `Thm.` and many more, with misspelt forms such as `c.f.` and `et. al.`, which the editor names after saving and never changes) |
| `key_style` | key style for entries added from Crossref or arXiv |
| `bib_add_to` | the `.bib` file that receives them (default: the smallest one the paper uses) |
| `build` | the build command, run in the main file's directory (default: `make` if there is a `Makefile`, otherwise `latexmk -pdf -synctex=1`) |
| `code_envs` | more environments to show as editable code boxes |
| `external_editor` | the command of **Open in your editor**, a list in which `{file}`, `{line}` and `{col}` are replaced, e.g. `["code", "-g", "{file}:{line}:{col}"]` (default: `emacsclient -n -a emacs +{line}:{col} {file}`, else VS Code, else the system's opener) |

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

Maths is read as words: `\Pr[x \sample S]` as "the probability that x is
sampled from S", `|X|` as "the size of X", Greek letters by name, and the
paper's own macros as what they print (`\qe` = `q_{\mathrm{eval}}` is
"q eval"). Media keys and the system's media controls pause, resume and
skip; when something else pauses the sound (a headset taken off), the
buttons follow. A sentence a voice cannot read is skipped with a note;
three in a row stop reading with the reason.

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
