# Demos

Each GIF is the editor driven by a script in headless Chrome, on a built copy
of the `tests/fixtures/ieee-conf` paper. The pointer is drawn by the recorder.

## Editing text

### Type into the rendered paper, bold a phrase, save

The edit lands in the `.tex` file as `\textbf{…}` and the PDF rebuilds.

![Type into the rendered paper, bold a phrase, save](demos/typing-and-saving.gif)

### Undo and redo

![Undo and redo](demos/undo-redo.gif)

### Inline maths with `$`

![Insert an inline formula with $](demos/inline-maths.gif)

### Displayed equation with `Ctrl+Shift+M`

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

![Game editor: insert a While block, colour a line, apply](demos/game-editor-editing.gif)

### Edit a table cell by cell

![Edit a table cell by cell](demos/table-cells.gif)

### Undo inside the game, table and formula editors

![Undo and redo inside the game, table and formula editors](demos/subeditor-undo.gif)

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
