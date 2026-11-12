# Demos

Each GIF is the editor driven by a script in headless Chrome, on a built copy
of the `tests/fixtures/ieee-conf` paper. The pointer is drawn by the recorder.
`node tests/record_demos.js [name …]` records them again.

## Editing text

### Type into the rendered paper, bold a phrase, save

The edit lands in the `.tex` file as `\textbf{…}` and the PDF rebuilds.

![Type into the rendered paper, bold a phrase, save](demos/typing-and-saving.gif)

### Undo and redo

![Undo and redo](demos/undo-redo.gif)

### Inline maths with `Ctrl+M`

`$` types a dollar sign; typed over a selection, it makes the selection maths.

![Insert an inline formula with Ctrl+M; $ over a selection](demos/inline-maths.gif)

### Displayed equation with `Ctrl+Shift+M`

The cursor starts on the empty line, and the preview keeps its height while
you type.

![Insert a displayed equation](demos/displayed-equation.gif)

### Cite by searching the bibliography

![Insert a citation by searching the bibliography](demos/citation.gif)

### Reference by searching labels

![Insert a cross-reference by searching labels](demos/reference.gif)

### Find and replace across the paper

![Find and replace across the paper](demos/find-and-replace.gif)

### New section heading with `Ctrl+Alt+1`

![Add a section heading at the cursor](demos/section-heading.gif)

## Games and tables

### Game editor: insert a `while` block, colour a line, apply

Apply shows the edited game in the paper at once; the typeset picture
replaces it after the save's build.

![Game editor: insert a While block, colour a line, apply](demos/game-editor-editing.gif)

### Edit a table cell by cell

![Edit a table cell by cell](demos/table-cells.gif)

### Undo inside the game, table and formula editors

Each undo and redo says so, flashes what changed and keeps the cursor
where it was; the formula editor has its own undo.

![Undo and redo inside the game, table and formula editors](demos/subeditor-undo.gif)

## Reading

### `Ctrl`+click a reference or citation, `Alt+←` back

![Ctrl+click a reference to go to it, and back](demos/reference-jump.gif)

### Text size, apart from the interface

![A− and A+ change the paper's text, not the toolbar](demos/text-size.gif)

## Reviewing

### Diff against the last save

![Edit, then show the diff against the last save](demos/diff.gif)

### The file changes on disk while you edit

![The source changes on disk: reload or keep your edits](demos/outside-change.gif)

### Two columns

![Switch to two columns and back](demos/two-columns.gif)

### Light, dark or follow the system

![Cycle the colour scheme](demos/colour-scheme.gif)

## Converting

### Convert to anonymous LNCS, build it, open it

![Convert the paper to LNCS (anonymous), build it and open it](demos/venue-conversion.gif)

## Weird sessions

Recorded while hunting for real-world bugs: rapid typing, undo storms, `$` at
the caret, paragraph split and join, a storm of pastes, dialogs stacked on
dialogs, a narrow window, reading aloud while editing, converting with unsaved
edits, a file changed on disk mid-edit, and the diff view. No page errors, no
stuck dialogs, no lost edits in any of them.

### Chaos editing: type, undo, `$`, split, join, paste, duplicate, save

![Chaos editing](demos/weird-chaos-editing.gif)

### Dialogs stacked: menu, find, figure viewer, keys, help, paper

![Dialog stack](demos/weird-dialog-stack.gif)

### Layout workout: dark theme, two columns, bigger text, figure viewer tabs by number keys

![Layout workout](demos/weird-layout.gif)

### A narrow 760 px window

![Narrow window](demos/weird-narrow-window.gif)

### Reading aloud, then pausing and editing mid-sentence

![Reader](demos/weird-reader.gif)

### Convert with unsaved edits: save first, or convert the disk copy

![Convert with unsaved edits](demos/weird-convert-unsaved.gif)

### A storm of pastes: maths, bold, unicode, quotes, %, <tags>, \verb, \section

![Paste storm](demos/weird-paste-storm.gif)

### The file changes on disk while you edit: keep your edits (overwrite disk)

![External change, overwrite disk](demos/weird-external-build.gif)

### Diff against the last save, walk the changes, leave, save

![Diff view](demos/weird-diff-view.gif)
