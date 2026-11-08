# How the venue classes differ

What a converter between these classes has to handle. **V** = verified by
building `tests/fixtures/` (the fixture compiles with it, or fails exactly
as stated); **D** = from the class's documentation, not yet exercised by a
fixture. Facts change between class versions: re-run `tests/fixtures.py`
after updating a class in `tests/classes/`.

## Front matter

| Class (venues) | Authors and affiliations | Abstract | Keywords | Anonymous version |
| --- | --- | --- | --- | --- |
| IEEEtran conference (S&P, CSF, EuroS&P) | `\author{\IEEEauthorblockN{Name}\IEEEauthorblockA{Affiliation}}` (V) | `abstract` env after `\maketitle` (V) | `\begin{IEEEkeywords}…\end{IEEEkeywords}` (D) | no option: replace the author block by hand (V, conventionally "Anonymous submission") |
| llncs (Eurocrypt, Crypto, Asiacrypt, TCC, PKC) | `\author{A\inst{1}\orcidID{…} \and B\inst{2}}`, `\institute{X \email{…} \and Y}`, `\authorrunning`, `\titlerunning` (V) | `abstract` env after `\maketitle` (V) | `\keywords{a \and b}` inside the abstract (V) | no option: replace authors and institutes (D) |
| acmart sigconf (CCS) | `\author{…}\affiliation{\institution{…}\city{…}\country{…}}\email{…}` per author (V) | `abstract` env **before** `\maketitle` (V) | `\keywords{a, b}` before `\maketitle` (V) | class option `anonymous` hides authors; `review` adds line numbers (V) |
| iacrcc (CiC) | `\addauthor[inst={1,2}, email=…, orcid=…]{Name}`, `\addaffiliation[country=…, ror=…]{Name}` (V) | `textabstract` env (V) | `\keywords{a, b}` (V) | class option `version=submission` (D) |
| iacrtrans (ToSC, TCHES) | `\author{A\inst{1} \and B}`, `\institute{…}` (V) | `abstract` env after `\keywords` (V) | `\keywords{a \and b}` (V) | class option `submission` (V: builds; D: hides authors) |
| svjour3 (JoC) | `\author{A \and B}`, `\institute{A \at X \\ \email{…} \and B \at Y}` (V) | `abstract` env with `\keywords{a \and b}` inside (V) | inside the abstract (V) | no option (D) |
| lipics-v2021 (ITP) | `\author{Name}{Affiliation}{email}{ORCID}{funding}` (V), plus `\authorrunning`, `\Copyright`, `\ccsdesc` (V) | `abstract` env (V) | `\keywords{a, b}` (V) | class option `anonymous` (D) |
| article | `\author{…}`, free form (V) | `abstract` env (V) | none standard | by hand |

Metadata that only some classes take, and that conversion must ask for when
the target needs it: ORCID (llncs, iacrcc, LIPIcs), ROR id and country
(iacrcc), email per author (iacrcc, acmart, LIPIcs), city and country
(acmart), licence (iacrcc `\license{CC-by}`, LIPIcs `\Copyright`), ACM CCS
concepts (acmart, LIPIcs `\ccsdesc`), running title and authors (llncs,
iacrcc `running=`, LIPIcs), event data (LIPIcs `\EventEditors` …), journal
name (svjour3 `\journalname`).

## Body

| Class | Theorem environments | `\cref` | Bibliography | Tables | Appendices | Columns |
| --- | --- | --- | --- | --- | --- | --- |
| IEEEtran | none predefined: needs amsthm and `\newtheorem` (V) | works, cleveref after hyperref (V) | BibTeX, `IEEEtran.bst` (V) | caption above (convention), `TABLE I` numbering (V) | `\appendices`, numbered A, B … (V) | two; `figure*` spans both (V) |
| llncs | predefined (theorem, lemma, corollary, proposition, definition, example, remark, note, claim, …); `\spnewtheorem` for more (V) | works; each `\spnewtheorem` type needs `\crefname` (V) | BibTeX `splncs04.bst` (V), or biblatex with biber (V) | caption above (D) | `\appendix` (D) | one |
| acmart | amsthm loaded; theorem, lemma, … predefined (D) | works (V) | natbib, `\citet`/`\citep`, `ACM-Reference-Format.bst` (V) | caption above (V) | `\appendix` (D) | two in sigconf (V) |
| iacrcc | predefined (V: `theorem`) | **does not load**: "cleveref must be loaded after hyperref" (V) | BibTeX, style set by the class (V) | (D) | `\appendix` (D) | one |
| iacrtrans | predefined (V: `theorem`) | **does not load** (as iacrcc) (V) | BibTeX, any style (V: `alpha`) | **booktabs not loaded**: `\toprule` needs `\usepackage{booktabs}` (V) | `\appendix` (D) | one |
| svjour3 | predefined (theorem, lemma, …) (V) | **incompatible**: infinite loop on `\cl@chapter` (V) | BibTeX `spmpsci.bst` (V) | (D) | `\appendix` (D) | one |
| lipics-v2021 | predefined (theorem, lemma, …) (V) | via the class option `cleveref` (V) | BibTeX `plainurl.bst` (V) | (D) | `\appendix` (D) | one |

Acknowledgements: acmart `\begin{acks}` (hidden by `anonymous`) (D);
svjour3 `\begin{acknowledgements}` (D); LIPIcs `\acknowledgements{…}` (D);
others a `\section*{Acknowledgments}` by hand. An anonymous version must
drop them in every class.

## Consequences for conversion

1. Into iacrcc, iacrtrans or svjour3: rewrite `\cref{x}`/`\Cref{x}` as
   `Name~\ref{x}`, with the name from the label's type in the `.aux`
   (Section, Theorem, Fig., …), and drop `\usepackage{cleveref}`.
2. Into IEEEtran: add amsthm and a `\newtheorem` for every theorem-like
   environment the body uses.
3. Into llncs: drop `\newtheorem` for environments llncs predefines (a
   redefinition is an error); use `\spnewtheorem` (and `\crefname`) for
   the rest.
4. Into acmart: `\cite` works (natbib); keep `\citet`/`\citep` out of
   classes without natbib, or load natbib there.
5. Bibliography: `\bibliographystyle` follows the target (IEEEtran,
   splncs04, ACM-Reference-Format, plainurl, spmpsci); biblatex papers keep
   biblatex unless the target forbids it (acmart supports both).
6. `\appendices` (IEEEtran) ↔ `\appendix` (others).
7. Front matter from the metadata, never by rewriting the old commands.
8. Anonymous: the class's own mechanism where there is one (acmart
   `anonymous`, iacrtrans `submission`, iacrcc `version=submission`, LIPIcs
   `anonymous`), otherwise an "Anonymous submission" author block; and
   acknowledgements and funding removed in every class.

Not yet covered: Springer Nature `sn-jnl` and `iacrj` (class files not
available to the tests), USENIX (`usenix-2020-09.sty`, no licensed copy).
