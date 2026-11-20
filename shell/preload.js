// Electron has no window.prompt() (it throws "prompt() is not supported"),
// and the editor asks with it (report a problem, rename, replace, new file,
// go to line).  This gives the page one that blocks like the browser's: the
// main process shows a small dialog window and answers when it is closed.
'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('__shellPrompt', (message, value) =>
  ipcRenderer.sendSync('shell-prompt', String(message), String(value)));
webFrame.executeJavaScript(`window.prompt = (message, value) =>
  window.__shellPrompt(message === undefined ? '' : String(message), value === undefined || value === null ? '' : String(value));`);

// The window's spell checker (en-GB, set on the session), for the editor's
// spelling keys: whether a word is misspelled, its suggestions, and adding a
// word to the window's dictionary.
contextBridge.exposeInMainWorld('__shellSpell', {
  misspelled: (word) => webFrame.isWordMisspelled(String(word)),
  suggestions: (word) => webFrame.getWordSuggestions(String(word)),
  add: (word) => ipcRenderer.send('shell-spell-add', String(word)),
});

// Ctrl+F the editor did not take (it leaves it to the browser in the source
// view): Electron has no find bar, so the window asks for the text.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
  e.preventDefault();
  ipcRenderer.send('shell-find');
});
