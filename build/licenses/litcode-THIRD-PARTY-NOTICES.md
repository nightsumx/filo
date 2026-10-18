# Third-party notices

litcode (published as `lite-monaco`) is MIT licensed (see `LICENSE`). Parts of its source are ported from the projects below, some of them line by line, and keep their original copyright notices here as their MIT licenses require.

## CodeMirror 6

Ported from `@codemirror/state`, `@codemirror/view`, `@codemirror/commands` (and the structure of `@codemirror/search` and `@codemirror/autocomplete`). The ported parts are the document and change model, range sets, the height map and viewport, DOM input handling and the browser quirks it works around, selection, decorations, history and bidi ordering. Files that carry such code are under `src/core/model`, `src/core/view`, `src/core/input`, `src/core/edit/history.ts` and `src/core/browser.ts`.

Source: https://github.com/codemirror (https://codemirror.net)

```
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Monaco Editor / VS Code

Ported from the Monaco Editor (`monaco-editor`, generated from VS Code's sources): - `src/core/feature/fuzzy.ts`: the completion fuzzy matcher, ported line by line from `base/common/filters`.
- `src/core/chrome/minimapcore.ts`: the pre-baked minimap glyph tables (`minimapPreBaked`), byte for byte (checked against monaco-editor 0.52.2: scale 1 is 192 bytes and scale 2 is 768 bytes, both identical).
- Behaviour that litcode reimplements so it feels the same (word operations, key bindings, the diff algorithm, layout formulas). These were rewritten, not copied; the comparison I ran found no run of 20 or more identical tokens in `words.ts`.

Source: https://github.com/microsoft/monaco-editor, https://github.com/microsoft/vscode

```
The MIT License (MIT)

Copyright (c) 2016 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Codicons

`src/core/chrome/codicon-font.ts` embeds the codicon icon font (copied from `monaco-editor`), used for the folding, search and completion icons.

Source: https://github.com/microsoft/vscode-codicons. Copyright (c) Microsoft Corporation. The repository licenses its content under Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/) and its code under MIT. The font is credited here under the stricter of the two, CC BY 4.0: it is used unmodified apart from being base64 encoded into a stylesheet.

## find-cluster-break

`@marijn/find-cluster-break` is a runtime dependency (MIT, Copyright (C) 2024 Marijn Haverbeke). It is installed with its own license by the package manager.
