# Plan: Emacs alignment, contents sidebar, label rename, literal search, multiple cursors

Status: planned, nothing implemented yet. Line numbers refer to `static/app.js`
at commit 2325645 and will drift.

Sources read for this plan: `~/.config/emacs.default/configs/*.el`
(keybindings, editing, completion, LaTeX), `~/.config/emacs.default/.mc-lists.el`,
and the editor's keymap (`ACTION_DEFS`, `TEXT_KEYS`, `GLOBAL_KEYS`), find
(`FIND`, `searchMaps`), labels (`collectLabels`) and undo (`HISTORY`, `snapshot`).

## Order of work

0. Electron shell, evaluated before any new feature (section 0).
1. Prefix keys, which-key hint, `C-g`/`M-g` swap, `en-GB` spell checking.
   Small, and later steps need prefix keys. Done 2026-11-20 (section 1).
2. Contents sidebar (Contents and Results tabs, filter, current section).
3. Label rename from the Results tab.
4. Literal maths search, plus a consult-style result list for `C-f` and `C-S-f`.
5. Multiple cursors: paper view, then source view.
6. Kill ring, source-view completion and electric pairs, latexindent,
   spelling keys `C-,` and `C-.` (section 6b).
7. One sentence per line on save (section 7). Done 2026-11-19.
8. Merging sections, subsections and subsubsections (section 8). Done
   2026-11-20, with the departures listed at the end of section 8.
9. Deleting text before the abstract must not break the PDF (section 9).
   Steps 1 and 2 done 2026-11-19, step 3 (the general check) 2026-11-20.

Every step adds `tests/e2e.js` cases (headless Chrome only, no visible
windows). They check the files on disk after the change, and that a single
undo reverses each batch.

## Open decisions

1. Maths search: does `$x$` find formulas that contain `x` as a token
   (proposed), or only formulas equal to `x`?
2. Move go to line to `M-g` and make `C-g` cancel? Yes, decided 2026-11-20.
3. Sidebar on the left or the right? List figures, tables and equations from
   the start? Left, headings only at first. Decided 2026-11-20.
4. Electric pairs in the paper view: on or off by default?
5. Merging: into the previous section by default, as Combine does now, with
   "into the next" only on a key. Decided 2026-11-19.
6. Merging files: the second file goes to the editor's trash. Decided
   2026-11-19 (a file left unused is a stale copy someone may edit later).

---

## 0. Electron shell (in evaluation)

Chrome keeps some keys for itself even in the app window, `C-w` (copy, in
your bindings) among them. `shell/` holds an optional Electron window
(Electron 45.3.4, Chromium 156). Since 2026-11-18 it is the default
`--browser` (and so the desktop entry's), with the Chrome app window as the
fallback when Electron is not installed and as `--browser chrome-app`.

What the shell does: no application menu (so no reserved accelerators), F12
and `C-S-i` for the developer tools, a profile of its own, a confirmation
before closing with unsaved edits (Electron would close silently), a context
menu with en-GB spelling suggestions, the PDF in a window of its own, other
sites in the system browser. Without Electron installed it falls back to the
Chrome app window.

Checked so far (hidden windows only):

- `--probe`: all 17 keys tried reach the page, and the window stays open
  after `C-w`: `C-w`, `C-S-w`, `C-t`, `C-n`, `C-S-n`, `C-S-t`, `C-Tab`,
  `C-S-Tab`, `C-PageDown`, `C-PageUp`, `C-S-c`, `C-S-j`, `C-q`, `C-r`, `C-l`,
  `M-g`, `C->`. These are synthetic events, so a check with real key presses
  is still needed.
- `--smoke`: the editor loads a fixture paper with no console errors.
- Backend tests pass after the `server.py` change.

To check by hand in a real window before deciding:

- [ ] Real key presses: `C-w`, `C-Tab`, `C-S-c`, `C-q` reach the editor.
- [x] `prompt()`: Electron throws "prompt() is not supported", which broke
      Report a problem and the other eight places that ask for text (rename
      file, replace, add a bib entry, new section, new file, go to line).
      `shell/preload.js` now gives the page a `prompt()` that opens a small
      modal window and blocks like the browser's. Later, when `app.js` is
      free, replace all `prompt()` calls with an in-page dialog for both
      windows, and drop the shim.
- [ ] Typing, paste, undo, save, the save conflict dialog.
- [ ] Closing with unsaved edits asks first. Closing stops the server.
- [ ] The PDF window opens (`C-M-d`).
- [ ] Reading aloud: the browser voices (speechSynthesis on Linux may have
      none in Electron) and the server voices.
- [ ] Spell checking in en-GB, with suggestions on right click.
- [ ] Self-reload after a change to `server.py` or `static/`.
- [x] Zoom: the window was smaller than the Chrome app window, which is at
      125% (Chrome zoom level 1.22). The window now starts at the Chrome app
      window's zoom (`server.py` passes `--chrome-zoom`). Ctrl+wheel changes
      it in half steps and saves it in `electron-profile/zoom.json`, which
      wins from then on. Chrome's `C-+`/`C--` page zoom stays off, since the
      page uses `C-+` for expand region.
- [ ] Dock icon and window name on Wayland.
- [ ] Downloads and file choosers (conversion, images).

### Found in the hunt for small problems (2026-11-18)

Fixed in `shell/`, checked in hidden windows where possible:

- `C-S-i` opened the developer tools, which took the editor's italic. Only
  F12 opens them now.
- Ctrl+F in the source view: the editor leaves it to the browser's find bar,
  which Electron does not have. The window now asks for the text and uses
  Chromium's find in page. The same text again goes to the next match, and
  an empty one ends the search. Checked by `--smoke`.
- No window icon: Electron reads no SVG. `shell/icon.png` is made from
  `static/icon.svg` (`rsvg-convert -w 256 static/icon.svg -o shell/icon.png`).
- Two `./run --browser electron` at once would share one profile between two
  processes, which Chromium does not support. A second launch now opens its
  window in the first process.
- A file dropped outside the text navigated away from the editor, and the
  shell sent it to the system's viewer. The editor now stays where it is.
- F11 (full screen) and Ctrl+0 (zoom back to the Chrome app window's) did
  not exist without the menu. Both are now the window's own keys. The editor
  uses neither.

Not fixable in the shell:

- Reading aloud: the Chrome app window uses "Google UK English Male". Google
  voices exist only in Google Chrome, and Electron has no browser voices at
  all (0 found). The Electron window falls back to the server's Edge voices.
- `prompt()` shim and Ctrl+F fallback are stopgaps until `app.js` has its own
  dialog and source-view find, which would also serve Chrome.

Still to confirm in a visible window:

- [ ] The dock shows the editor's icon and name (`desktopName` in
      `shell/package.json` points at the hidden `crypto-paper-reviewer-x11`
      entry; not visible in a hidden window).
- [ ] `C-w` copies to the system clipboard (the hidden test wrote it, but the
      Wayland clipboard did not show it, which may only be because the window
      had no focus).
- [ ] Second launch opens a second window in the same Electron.
- [ ] The PDF window (`C-M-d`) shows the PDF (the test paper had no build).
- [ ] The Edge voice is acceptable for reading aloud.

### Electron tests

Worth adding, and small, because they cover what the browser tests cannot:
the window's own code in `shell/main.js` and the keys Chrome reserves.
`tests/electron_test.js` runs only when `shell/node_modules` has Electron,
and otherwise prints that it skipped. All windows are hidden. It checks:

- Reserved keys (`--probe`): every key in the list reaches the page, and
  `C-w` does not close the window.
- `prompt()` returns the typed text, and Report a problem writes its file
  (both in `--smoke` already).
- Loading (`--smoke`): a copy of a fixture paper loads with no console errors,
  at the zoom passed in `--chrome-zoom`, and a saved `zoom.json` wins over it.
- Editor actions on reserved keys: `C-w` in a paragraph copies the line
  (clipboard text), `C-q` deletes back, `C-Tab` and `C-S-c` reach the keymap
  once those bindings exist.
- Unsaved edits: closing triggers `will-prevent-unload` (the dialog is
  answered by the test), and "Stay" keeps the window open.
- Links: a non-local `window.open` is denied (sent to the system browser),
  and the `/pdf` window opens.
- Spelling (after section 6b): the preload API returns suggestions for a
  misspelled word.

These keep using synthetic input events, so the hand check with real key
presses above is still done once before switching the default.

If it passes, make `electron` the default when it is installed, point the
desktop entry at it, and keep `chrome-app` as the fallback. The cost is npm and
about 100 MB of Electron for anyone who chooses it, so it stays optional for
the "Python 3 only" install.

---

## 1. Emacs alignment

### Already the same

`C-s` save, `C-z`/`C-S-z` undo/redo, `C-p` duplicate, `C-d` delete line,
`C-w` copy region or line, `M-w` cut region or line, `C-q` delete back,
`C-Backspace` delete to the previous space, `C-+` expand region, `C-a`/`C-e`
(start of code, then of line, in the source view, as mwim), `Tab`/`S-Tab`
indent, `Enter` indenting like the line above, `C-S-r` replace.

### Gaps

| Emacs | Editor now | Plan |
|---|---|---|
| multiple-cursors (`C->`, `C-<`, `C-M->`, `C-M-<`, `C-S-c C-S-a`, `C-S-c C-S-c`, `C-S-c C-S-d`, `C-S-c C-S-n`) | none | Section 5, with these keys |
| Prefix keys (`C-c …`, `C-S-c …`), which-key | single keys only | Prefix keys in `keyName` and the keydown dispatch, and in `keys.json` (`"C-S-c C-S-a"`). After a prefix, a which-key-style hint lists the possible next keys |
| `C-g` cancels | `C-g` is go to line (source view) | `C-g` acts as Escape everywhere: close menus, drop extra cursors, collapse the selection. Go to line moves to `M-g`, as in consult |
| `C-f` consult-line | find bar | Keep the bar and add a result list: one row per match with its context, the page follows the selected row, Enter stays there |
| `C-S-f` consult-line-multi | none | Search the raw source of every `.tex` and `.bib` file, with results listed by file and line |
| `C-S-v` consult-yank-pop | none | Kill ring of the last 30 copies and cuts (`C-w`, `M-w`, browser copy), picked in the existing palette |
| `C-l` consult-find, `C-x C-r` recent files | `C-M-n` Files, recent papers in the menu | `C-l` opens the file picker and jumps to the file's first block. `C-x C-r` opens recent papers in a palette |
| corfu on `\`, `\begin{env}` adds `\end` | none in the source view | Completion popup in the source view: macros from the document and preamble, environments, labels after `\cref{`, cite keys after `\cite{` |
| `electric-pair-mode` | wraps a selection only | `(`, `[`, `{` at the caret insert the pair. On by default in the source view, a setting in the paper view |
| `C-c f` latexindent | none | The server runs `latexindent` on the current file (source view). Empty output leaves the file untouched |
| flyspell en_GB | `<html lang="en">` | `lang="en-GB"` on `#doc`, configurable |
| `whitespace-cleanup` on save | none | Opt-in only, since it changes bytes the round-trip tests rely on |

Left out: `C-r` windresize, `C-S-b` buffer moves, `C-x f` bookmarks,
tempel and Easycrypt snippets, `C-<tab>` (Chrome keeps Ctrl+Tab).

### Risk

Chrome may keep `Ctrl+Shift+C` for DevTools even in the app window. Test
whether `preventDefault` takes it before relying on the `C-S-c` prefix. The
fallback is `C-c C-a`, `C-c C-c` and so on.

### Done (2026-11-20)

- `C-g` (action `cancel`) closes the popover, menu, dialog or find bar on
  top, else drops the selection. It works from fields too. In the source
  view it never leaves the view (Escape still does). Go to line is `M-g`.
- Chords: a key written `"C-c C-a"` in `keys.json`, or recorded in **Keys…**
  as presses less than a second apart. After the first key a hint
  (`#whichkey`, bottom left) lists the next keys and their actions. `C-g` or
  Escape drops the chord, and an unbound chord says so in a toast. A key
  that is bound alone and also starts a chord is marked as a clash in
  **Keys…**. No default action has a chord yet: the multiple-cursor keys of
  section 5 will be the first, after the `C-S-c` test above.
- `#doc` has `lang="en-GB"`, from the config key `spell_lang`. The Electron
  window already used `en-GB`.
- Tests: `node tests/e2e.js 'keys: '`.

---

## 2. Contents sidebar

- Toggle with a toolbar button and a key (proposed `C-c o`). The state is
  remembered per viewer. On narrow windows the sidebar overlays the page
  instead of shrinking it.
- Tabs:
  - Contents: sections, subsections and `\paragraph`, numbered as on the
    page and indented by level.
  - Results: every environment in `L.THM_ENVS` (lemma, theorem, definition
    and so on) with type, number, optional title and label, for example
    `Lemma 4 (Hybrid 2) lem:h2`.
  - Later, possibly: figures, tables, equations.
- Data: walk `ORDER` (heading segments, and `thmhead` tokens with their
  `\label`). Numbers come from `DOC.aux.labels`, as in `collectLabels()`
  (around line 5708).
- Click or Enter jumps there and puts the caret at the start, through the
  code of `stepBlock`/`followRef`, so `Alt+←` goes back.
- An IntersectionObserver highlights the section in view.
- A filter box at the top matches words in any order, like orderless (the
  matcher of `refPalette`).
- Rebuilt after `render()` and, debounced, after `markEdited`.
- In the source view the same sidebar replaces the `#srcoutline` dropdown
  and jumps to the source line.

---

## 3. Label rename

From the Results tab, F2 or a double-click on a label opens an inline field.
On Enter:

1. Check the new key: no spaces, `{`, `}`, `,`, `%`, `\` or `#`, and not
   already a label.
2. `snapshot()`, then `commit()`.
3. Replace the key in every file text:
   - `\label{k}`;
   - `\ref`, `\cref`, `\Cref`, `\eqref`, `\autoref`, `\nameref`, `\pageref`,
     `\cpageref`, `\labelcref`, including keys inside lists such as
     `\cref{a,k,b}`;
   - `\crefrange{k}{…}` and `\hyperref[k]`.

   Working on the raw text also covers hidden segments and game sources.
4. `render()`. One `C-z` undoes the whole rename.
5. A toast reports the counts, for example
   "Renamed lem:h2 → lem:hybrid2: 1 label, 7 references".

Optional: a command that finds labels whose prefix does not match their
environment (a lemma labelled `thm:…`) and fixes them in one step.

---

## 4. Literal search with maths (`hello $x$`)

`searchMaps()` (around line 5770) walks each block, but turns every maths
chip into a `\u0000` barrier, so maths cannot be searched.

- Index: a maths chip contributes `\u0001`, its normalised LaTeX body, and
  `\u0002`. Normalising removes spaces and writes `{x}` as `x`. The body is in
  `chip.dataset.src`.
- Query: the latex.js tokenizer splits it into text parts and maths parts.
  - Text outside `$…$` matches only text, as now.
  - `$…$` matches only inside a formula.
  - A space between parts matches any spacing.
- Matching inside maths (proposed):
  - `$x$` matches a formula that contains `x` as a whole token, so it finds
    `$x_1+y$` but not `\max` or `\exp`.
  - `$=x$` matches a formula equal to `x`.
  - `$$` matches any formula, so `hello $$` finds "hello" followed by a
    formula.
- A match is widened to the whole chip, as `snapOutOfChips` does. Replacing a
  maths match rewrites the chip's source.
- A "Literal (text + $maths$)" toggle next to the regex, case and word
  toggles. It is on by default when the query contains `$`.

---

## 5. Multiple cursors

### Constraint

A page has one real selection, and contenteditable edits act on it only.
Extra cursors are virtual: stored, drawn and applied by the editor. The real
caret is the primary cursor.

### Model

- `MC = { cursors: [Range…], primary }`. Each cursor is a live DOM `Range`,
  collapsed for a caret, or spanning text for a selection.
- Live Ranges follow DOM changes, so an edit at one cursor moves the others
  without offset bookkeeping.
- A cursor must lie in one `#doc [contenteditable=true]` text block.
  Positions in chips, figures, games or quiet blocks are refused, and so is a
  selection that crosses blocks (`spansEditables`).

### Applying an edit at every cursor

Each edit runs through the real selection, once per cursor, so the existing
behaviour is reused:

```js
function eachCursor(fn) {
  snapshot();                       // one undo step for the whole batch
  MC.replaying = true;
  for (const r of sortedReverseDocOrder(MC.cursors)) {
    setSel(r); fn(); r.setStart(...selStart()); r.setEnd(...selEnd());
  }
  MC.replaying = false;
  setSel(MC.primary); redrawCursors(); markEditedSoon();
}
```

- In keydown, before the `TEXT_KEYS` and `WRAP_PAIRS` handling: with more
  than one cursor and a supported key, `preventDefault()` and `eachCursor`.
  - Printable characters: `execCommand('insertText', key)`.
  - Backspace and Delete: `execCommand('delete')` and
    `execCommand('forwardDelete')`.
  - Arrows, Home, End: `getSelection().modify(...)`, with Shift extending.
  - `TEXT_KEYS` actions (`wrap`, `$` maths, bracket wrapping): the existing
    function per cursor.
  - Paste: the same text at every cursor, or one line per cursor when the
    number of lines equals the number of cursors.
- Cursors are processed from last to first, so each edit leaves the earlier
  cursors in place.
- While `MC.replaying` is set, the `beforeinput` handlers (around lines 4701
  and 4893) skip the typing snapshot and the cross-block banner.
- Version 1 refuses, with a banner, edits that change the page structure:
  Enter (splitting a block), Backspace at the start of a block (merging),
  heading commands, section move and merge.

As in `.mc-lists.el`, each action has a flag for whether it runs at every
cursor or once. At every cursor: line start and end, copy region or lines,
indent and unindent, wrapping (bold, emph, `$`). Once: save, undo, find,
build, sidebar jumps.

### Keys (multiple-cursors.el)

| Key | Action |
|---|---|
| `C->` / `C-M->` | Mark next / previous like this (the selection's text, or the word at the caret) |
| `C-<` / `C-M-<` | Unmark the last next / previous |
| `C-S-c C-S-a` | Mark all like this (also from the find bar, using `FIND.matches`, so literal maths search can feed it) |
| `C-S-c C-S-c` | Edit lines: one cursor per line of the region (mainly the source view) |
| `C-S-c C-S-d` | Mark all dwim: the selection's text in the current block, then the whole paper on repeat |
| `C-S-c C-S-n` | Insert numbers 0, 1, 2, … at the cursors |
| `C-S-click` | Add a cursor |
| `C-g` / `Esc` | Back to one cursor |

All are `ACTION_DEFS` entries, so `keys.json` can rebind them.

### Drawing

- Selected text: the CSS Custom Highlight API,
  `CSS.highlights.set('mc', new Highlight(...ranges))`. Its ranges are live.
- Carets: absolutely positioned 1px divs in an overlay, placed from each
  Range's client rect, blinking with CSS.
- Redraw after each batch, and on scroll, resize, two-column toggle, text
  size and page width changes.

### Clearing

All cursors are cleared on `render()` (undo, redo, save, build, outside
change, conversion), on entering the diff view, when the figure viewer or a
dialog opens, and on a plain click. A render replaces the DOM nodes the
Ranges point to, so keeping cursors across it would need offset mapping.

### Source view

The `#srcta` textarea uses plain string offsets. Edits rewrite `value`
through `insertText` to keep native undo. A mirror div draws the carets.
"Edit lines" belongs here, so this follows right after the paper view.

### Tests (`node tests/e2e.js multi`)

- Cursors in two paragraphs, type, save: both `.tex` files get the text.
- `C->` three times, type: three replacements, one `C-z` restores them all.
- Backspace with a cursor at a block start: no merge, a banner is shown.
- A cursor inside a maths chip is refused.
- Two cursors in one text node, edited last to first: offsets stay correct.
- After a save or build: one cursor left, no overlay elements remain.
- A `ui_torture.js` case mixing cursor edits with random operations,
  checked against the round trip.

---

## 6b. Spelling keys: `C-,` and `C-.`

These follow flyspell, where `C-.` is `flyspell-auto-correct-word` and `C-,`
moves to the next error.

- `C-,` opens the spelling suggestions for the misspelled word at the caret,
  or else the nearest misspelled word before it in the same block. The list
  appears at the word, in the style of the palette. Up/Down and Enter, or
  1 to 9, replace the word. "Add to dictionary" is the last entry. Escape
  closes it. Pressed again with the list open, it moves to the next
  misspelled word.
- `C-.` replaces the misspelled word at or before the caret with the first
  suggestion, with no list. Pressed again at once, it cycles through the next
  suggestions in place, as flyspell does. A toast names the word and the
  replacement, and one `C-z` undoes it.
- Words are taken from the block's text nodes only. Maths chips, references,
  citations, labels and `\verb` are skipped, as in the find index of
  section 4. Words in the paper's own dictionary (below) are never flagged.

Where the suggestions come from:

- In the Electron window, a preload script exposes the window's spell checker
  to the page with `contextBridge`. It calls `webFrame.isWordMisspelled(word)`
  and `webFrame.getWordSuggestions(word)`, using the en-GB dictionary already
  set on the session. "Add to dictionary" calls
  `session.addWordToSpellCheckerDictionary`.
- In the Chrome app window, a page cannot ask Chrome's spell checker. There,
  `server.py` answers `/api/spell` with `hunspell -d en_GB` (installed, and
  the dictionary your flyspell uses). Without hunspell, the keys show a
  banner saying spelling suggestions need hunspell or the Electron window.
- A paper dictionary in `.paper-editor/words.txt` (one word per line) holds
  words added from either path, so names such as "Fiat" or "IND-CCA" are
  added once per paper.

Keys: both are `ACTION_DEFS` entries in the text scope (`C-,` and `C-.` are
unused now, and Chrome does not reserve them), so `keys.json` can rebind
them. Tests: e2e cases on a paragraph with a known misspelling ("recieve"):
`C-.` gives "receive" on disk after a save, a second `C-.` cycles, `C-z`
restores the word, `C-,` lists suggestions and Enter applies the chosen one,
a word inside maths is never offered.

## 7. One sentence per line on save

### Now

`houseRules` in `static/latex.js` has `one_sentence_per_line` (off by
default). It replaces `([.!?])\s+(?=[A-Z\\])` with a line break, on the
whole serialised block. That splits inside maths (`$x. Y$`), after
abbreviations (`e.g. \cite`, `Fig. \ref`, `et al. Smith`, `J. Smith`),
inside `\verb`, `\url`, comments and code, and it rewrites lines of the
original that the author did not touch.

### Rule

Work on the token list of `L.tokenize`, not on the string, and split only in
`text` tokens that sit where a line break is a space to TeX:

- the top level of a paragraph, quote, caption or `\item`;
- inside `fmt` (`\emph`, `\textbf`) and the argument of `\footnote`.

Never inside `math`, `comment`, `\verb`, `\url`, `\texttt`, `\path`,
code environments, games, tabulars, or any `group` or `cmd` argument not
listed above. Those tokens are copied unchanged.

A sentence ends at `.`, `!` or `?`, followed by any closers `)`, `]`, `'`,
`''`, `’`, `”`, `}`, then by plain spaces (not `~`, `\ `, `\,`), and the
next token starts a sentence: a capital letter, an opening quote or
bracket followed by a capital, or a command that starts text
(`\Cref`, `\emph`, `\textbf`, a macro whose expansion starts with a
capital). The spaces become one line break.

Not a sentence end:

- a period that belongs to an abbreviation in the list below;
- a single capital before the period (an initial, `J. Smith`), unless
  written `X\@.`;
- a period inside a number or a name (`3.2`, `v1.0`, `ePrint 2024/123.`
  then lowercase), since no space follows or no capital comes next;
- an ellipsis (`...`, `…`, `\dots`, `\ldots`) with no period after it;
  `\dots.` followed by a capital does end a sentence;
- a period followed by `~` or `\ ` (the author has said it is not an end).

A period right after maths (`$x$. Then`) is in a `text` token, so it does
split. A display (`\[ ... \]`, `equation`) is its own token: the text after
it starts on a new line only if it already did.

### Abbreviations: never a sentence end

A period that ends one of these is never split after, whatever follows it.
Matching ignores case and accepts the misspelt forms that occur in papers
(missing, extra or misplaced periods, a space inside). The splitter does
not correct them; a misspelling is a separate warning (below).

| Meaning | Forms matched |
| --- | --- |
| for example | `e.g.`, `eg.`, `e.g`, `e. g.`, `ex.` |
| that is | `i.e.`, `ie.`, `i.e`, `ie`, `i. e.` |
| compare | `cf.`, `c.f.`, `cf`, `conf.` |
| and so on | `etc.`, `e.t.c.`, `etc`, `ect.`, `e.t.c` |
| and others | `et al.`, `et. al.`, `et al`, `et.al.`, `etal.`, `et alii.` |
| versus | `vs.`, `v.s.`, `vs`, `v.` (between two names, as in case titles) |
| respectively | `resp.`, `resp` |
| namely, viz. | `viz.`, `viz`, `sc.` |
| note well | `N.B.`, `n.b.`, `NB.` |
| about | `ca.`, `approx.`, `appr.`, `approx` |
| idem, ibidem | `ibid.`, `id.`, `op. cit.`, `loc. cit.` |
| with respect to | `w.r.t.`, `wrt.`, `w.r.t`, `wrt` |
| without loss of generality | `w.l.o.g.`, `wlog.`, `w.l.o.g`, `W.l.o.g.` |
| with high, overwhelming probability | `w.h.p.`, `whp.`, `w.o.p.` |
| if and only if | `iff.` (rare, but seen) |
| independent and identically distributed | `i.i.d.`, `iid.`, `i.i.d` |
| uniformly at random | `u.a.r.`, `u.a.r` |
| polynomial time, probabilistic polynomial time | `poly.`, `p.p.t.` |
| references in the text | `Fig.`, `Figs.`, `Sec.`, `Sect.`, `Secs.`, `Eq.`, `Eqs.`, `Thm.`, `Thms.`, `Def.`, `Defn.`, `Lem.`, `Prop.`, `Cor.`, `Rem.`, `Ex.`, `Alg.`, `App.`, `Apx.`, `Ch.`, `Chap.`, `Tab.`, `Fn.`, `Prob.`, `Conj.`, `Obs.`, `Clm.`, `Hyb.`, `Exp.` |
| bibliographic | `No.`, `no.`, `Nos.`, `Vol.`, `vol.`, `pp.`, `p.`, `ed.`, `eds.`, `Ed.`, `Eds.`, `Proc.`, `Conf.`, `Symp.`, `Trans.`, `Univ.`, `Inst.`, `Dept.`, `Tech.`, `Rep.` |
| titles of people | `Dr.`, `Prof.`, `Mr.`, `Mrs.`, `Ms.`, `St.`, `Jr.`, `Sr.` |
| months | `Jan.`, `Feb.`, `Mar.`, `Apr.`, `Jun.`, `Jul.`, `Aug.`, `Sep.`, `Sept.`, `Oct.`, `Nov.`, `Dec.` |
| Latin and others | `a.k.a.`, `aka.`, `a.s.` (almost surely), `max.`, `min.`, `avg.`, `est.`, `incl.`, `excl.`, `esp.`, `cont.`, `orig.`, `rev.`, `ver.` |

The list lives in `static/latex.js` as data, and
`house_rules.abbreviations` adds to it (a paper's own, such as `Constr.`).

Misspellings: when the edited lines contain a misspelt form (`eg.`,
`e.g` without its last period, `c.f.`, `e.t.c.`, `ect.`, `et. al.`,
`et al` without a period, `ie.`, `wrt`, `iid`), the banner after saving
lists them with the standard form (`e.g.`, `cf.`, `etc.`, `et al.`,
`i.e.`, `w.r.t.`, `i.i.d.`). The editor never changes them by itself,
since a form such as `eg` can be a name or a macro argument.

### Scope

- Only blocks edited on the page (the house rules already run only on
  `touched` blocks), and only the lines of that block that the edit
  changed. A line that is in the original source unchanged keeps the
  author's layout, even with two sentences on it. Lines are matched by a
  line diff of the block against its original source, and a changed line
  is split as a whole.
- Lines are never joined. A line break the author typed stays.
- The question before saving names the change (it already says "one sentence
  per line" when the rule is on), and declining saves the text as typed.
- Headings are left alone. Captions use the same rule (a line break in a
  caption is a space).

### Place in the code

A function `splitSentences(text, original, rules)` in `static/latex.js`,
called from `houseRules` in place of the regular expression. It tokenises,
walks the tokens with the allowed contexts, rewrites the spaces in place,
and serialises with `serializeTokens`, so the result round-trips. A change
that would alter the token stream other than in whitespace is dropped (a
safety check: compare the token lists with whitespace normalised).

### Tests

- `tests/torture.js` or a new `tests/sentences.js`: a table of inputs and
  expected outputs, among them `$x. Y$`, `e.g.\ Smith`, `e.g. \cite{a}`,
  `Fig.~\ref{f}`, `et al. Smith`, `J. Smith`, `X\@. Then`, `3.2 Then`,
  `\dots and`, `\dots. Then`, ```Done.'' Then`, `(see X.) Then`,
  `\emph{One. Two.} Three.`, `\footnote{One. Two.}`, `% A. B` in a
  comment, `\verb|a. B|`, `\url{a. B}`, a game line, a tabular cell,
  and every form of the abbreviation table followed by a capital
  (`eg. Smith`, `c.f. Lemma`, `e.t.c. The`, `et. al. Show`); the
  fuzzer checks that the output differs from the input only in whitespace.
- e2e: type two sentences in one line of a paragraph and save: the file
  has them on two lines; a misspelt `c.f.` is listed in the question and
  left as typed; an untouched line with two sentences in the same
  block stays one line; declining the house rules keeps one line; one undo
  restores the text as typed.

## 8. Merging sections, subsections and subsubsections

### Now

**Combine** (Ctrl+Alt+J, a button on a section heading) only deletes the
heading: the text and subsections under it join the previous section. It is
the same as **Delete** on the heading. It does not look at levels, labels or
files, and nothing combines two subsections.

### What a merge does

Merging heading H (level *n*) into the previous heading P of the same level
*n*:

1. H's heading line goes. Its text and its children (levels below *n*)
   follow the end of P's last child, so they read as part of P.
2. **Children keep their level.** H's subsections become further
   subsections of P, numbered after P's own.
3. **Option: keep H's title as a sub-heading.** The question offers
   "Keep '<H>' as a subsection of '<P>'". Then H becomes a heading of
   level *n*+1 and every heading under it goes one level down
   (`\section` to `\subsection`, `\subsection` to `\subsubsection`,
   `\subsubsection` to `\paragraph`). A `\paragraph` under it stays a
   `\paragraph`. If that would need a level below `\paragraph`, the option
   is not offered and the question says why.
4. **Labels.** H's `\label` (on the heading line or right after it) is moved
   to P's heading line, so `\Cref{sec:h}` resolves to P's number and no
   reference breaks. With option 3 the label stays on the demoted heading.
   The question names the references that will now print P's number.
5. The merge is one structural change: one Ctrl+Z restores the headings, the
   levels, the labels and (below) the files.

Allowed for `\section`, `\subsection`, `\subsubsection` and `\paragraph`
(and `\chapter`, `\part` where the class has them), always within one level.
Merging into the first heading of a file, or into a heading of another
level, is refused with the reason. A starred heading can be merged, and the
merged heading keeps P's star or lack of one.

Where: a **Merge with the previous** button on every heading of these levels
(it replaces Combine on sections), the key Ctrl+Alt+J (as now, for every
level), and an entry in the heading's menu. Merging into the next heading
(decision 5) is Ctrl+Alt+Shift+J.

### Sections in their own files

When H and P are in different files that the document reads with `\input`
(`sections/related.tex` read right after `sections/intro.tex`), the
question asks:

> Merge "Related work" into "Introduction". The two are in different files.
> [Also merge the files] [Keep the files] [Cancel]

- **Also merge the files.** H's text (all of its file, when the file holds
  only H and its children, which is how **Section in a new file** makes
  them) is appended to P's file after one blank line. The `\input` of H's
  file is removed with the blank line before it, and H's file goes to the
  editor's trash on save (`/api/file/trash`, decision 6). This is
  `inlineFile` and `trash_file`, run on the merged text.
- **Keep the files.** Only the heading line (and label, as above) changes
  in H's file. The `\input` stays, so the merged section continues in the
  next file.
- When H's file holds more than H (another section after it), only H's part
  can move. The question then offers only "Keep the files".
- When the two `\input`s are not next to each other (text, a `\clearpage`
  or a comment between them), the question shows what lies between, and
  "Also merge the files" puts that text before H's text in P's file.
- `\include` (with its `\clearpage`) is treated like `\input`, and the
  question notes that a page break goes away.

The same question appears for subsections in separate files, since
**Section in a new file** can also make them.

### Undo and saving

The merge is one `structural` change. With the files merged it also records
the new P file text, the removed `\input`, and H's file marked for the trash.
Undo before saving brings all of it back. After saving, the history can bring
the files back (the trash keeps H's file). A save that fails on one file
(changed on disk) saves none of the merge, so the files stay consistent.

### Tests (`node tests/e2e.js merge`)

- Two sections in one file. Merge: one heading left, the text of both in
  order, the subsections numbered after P's, H's label on P's line, one
  Ctrl+Z restores the file exactly.
- Option "keep as a subsection": the levels go down by one under H, and
  `\subsubsection` becomes `\paragraph`. The option is absent when it would
  go below `\paragraph`.
- Two subsections, and two subsubsections. Refused across levels and for
  the first heading of the document.
- Sections in `sections/a.tex` and `sections/b.tex`, read one after the
  other. "Also merge the files": `a.tex` ends with B's text, main.tex has no
  `\input{sections/b}`, and `b.tex` is in the trash after saving.
  "Keep the files": both files stay and only B's heading line goes. Undo
  restores all three files before saving.
- A file with two sections: only "Keep the files" is offered.
- References: `\Cref{sec:b}` prints P's number after the next build (checked
  in the `.aux` of a real build in the intensive run).

### Done (2026-11-20)

`mergeHeading` in `static/app.js`, a question box (`ask`, `#askbox`), the
**Merge** button on every heading, Ctrl+Alt+J and Ctrl+Alt+Shift+J.
Tests: `node tests/e2e.js merge`. Departures from the plan above:

- `\paragraph` is not a heading block in the editor (`headingParts` does
  not read it), so a `\paragraph` cannot be merged. Keeping a
  `\subsubsection` one level down does make it a `\paragraph`.
- There is no heading menu, so no menu entry. The button and the keys are
  the only ways in.
- A label alone at the start of the block after the heading also moves.
- The save is not all or nothing. When a file of the merge is changed on
  disk, the other files are saved, and H's file is not moved to the trash
  until a save with no conflict.
- The `.aux` check of `\Cref` in a real build is not in the tests.

## 9. Deleting before the abstract breaks the PDF

### Report (2026-11-19)

Deleting a line or a paragraph just before the abstract often breaks the
build, and nothing on screen shows what went. The fix so far is the source
view. Seen in `threshold/note` (iacrcc), whose main file has, after
`\begin{document}`:

```
\maketitle

\keywords{...}

\begin{abstract}
Bellare et al. ...
```

The editor's history of that paper shows no edit that removed `\maketitle`,
`\keywords`, `\begin{abstract}` or `\begin{document}`, so the break is
something else (a lost blank line, a `}`, an `\end{...}` of the block
before, or text joined into a hidden command's argument). Reproduce first.

### What is on screen there

- `\maketitle` and `\keywords{...}` are in `HIDDEN`, so their paragraphs
  have only hidden chips and render as `quiet`, non-editable blocks
  (`renderPara`). They take no visible room, so the block above the
  abstract on screen is not the block above it in the source.
- `\begin{abstract}` is a `runin` chip ("Abstract. ") at the start of the
  abstract's paragraph.
- Backspace at the start of a paragraph calls `joinWithPrevious`, which
  joins with the previous `para` even when that one is quiet, so the
  abstract (or text typed there) can land after `\keywords{...}` in one
  paragraph, or inside what the user believes is the paragraph above.
- Backspace or Delete next to a chip lets the browser delete a hidden chip
  the user cannot see.

### Found (2026-11-19, headless probe)

- Backspace at the start of the abstract's first sentence: the first press
  deleted the line break after `\begin{abstract}` (nothing changes on
  screen), the second deleted `\begin{abstract}` itself.
- A selection from the paragraph above into the abstract deleted
  `\begin{abstract}` with the text.
- Fixed: Backspace and Delete stop at a `\begin`/`\end` mark or at the
  line break next to one, with a toast. Every deletion of a selection (in
  one block, across blocks, cut, Enter, typing over it, delete line) keeps
  a `\begin` or `\end` whose partner is not deleted too. A selection
  across blocks keeps blocks that show nothing (`\keywords`), and then does
  not join the first and last block. Test:
  `node tests/e2e.js frontmatter`.

### Steps

1. Reproduce in a copy of `threshold/note` and in the iacrcc, llncs and
   IEEEtran templates: select the paragraph above the abstract and delete
   it, Ctrl+Shift+K on it, Backspace at the start of the abstract, Delete
   at the end of the paragraph above. Record the source diff and the build
   error of each. Ask the user for Ctrl+Alt+Q the next time it happens.
2. Fix the causes found. Expected:
   - `joinWithPrevious` and Delete at a paragraph's end skip quiet blocks:
     they never join into one, and never delete one.
   - A keyboard deletion never removes a hidden chip it does not show.
     A selection that covers hidden chips keeps them (the deleted text goes,
     the commands stay), except when the whole block is selected and
     deleted on purpose, which then says in a toast what went.
   - `\begin{abstract}` and other `runin` chips are not deleted by a
     Backspace from the text after them.
3. Safety net for every edit, not only near the abstract: on each change,
   compare the paragraph's balance of `{`/`}` and `\begin`/`\end` (and the
   count of commands that may appear once, `\maketitle`,
   `\begin{document}`) before and after. If the change breaks it, undo it
   and say what it would have removed.
   Done 2026-11-20 for every edit the browser makes in a block (Backspace,
   Delete, typing, typing over a selection): `brokenBalance` compares the
   block's source before and after; the block is put back as it was and a
   toast names what went. It counts `{`/`}`, `\begin`/`\end` per
   environment, `\maketitle` and `\documentclass`. Edits made by the
   editor's own code (cut, delete line, a selection across blocks) are not
   checked: they go through `deleteKeepingEnvs` or `deleteAcross`.

### Tests (`node tests/e2e.js frontmatter`)

- The iacrcc front matter above. Each deletion of step 1 leaves
  `\maketitle`, `\keywords{...}`, `\begin{abstract}` and the blank lines
  between them as they were, and the paper builds.
- Deleting a visible paragraph between two quiet blocks removes only that
  paragraph.
- Backspace at the start of the abstract's first sentence does not remove
  `\begin{abstract}`.

