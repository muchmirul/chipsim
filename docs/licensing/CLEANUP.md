# Public repository cleanup

The 14 October 2026 cleanup removes publisher document bytes from the public
source distribution and its reachable Git history. It does not grant any new
rights to those documents. A separate private copy of the original repository
and references was preserved; the user's existing checkout was not cleaned,
reset or rewritten.

Changes to the public tree:

- All 34 vendor PDFs are excluded. Catalog metadata, source URLs, exact revisions
  and SHA-256 hashes remain available for private source verification.
- Document-rich screenshots and their captured text are excluded. The published
  screenshots are regenerated from four original PIO teaching views, without
  manual text, vendor tables or document excerpts.
- Profile and example citations use short factual technical terms or API/register
  identifiers rather than vendor prose. Original model interpretations and
  executable behavior remain ChipSim's implementation. Exact-source hashes,
  one-based pages and source checks remain enforced; an anchor match alone is
  not evidence that an interpretation is correct.
- Original synthetic test descriptions, functional symbol definitions, register
  names, truth-table facts and necessary file-format syntax remain. They are
  distinguished from publisher prose and complete document/table reproductions.
- The prior licensing audit, acknowledgments, software provenance and complete
  applicable license texts are included. Original ChipSim code remains MIT;
  copied PicoRV32 is ISC, cocotb adders are CC0, and simulator observers/context
  remain GPL-2.0-or-later.
- Public packages exclude nested run workspaces, generated binaries, private PDFs
  and extracted manual caches. Tests verify these exclusions even while private
  reference links exist.
- Public checks run without vendor bytes. Full source-backed acceptance remains
  a separate required-private-input workflow, documented in
  [LOCAL_REFERENCES.md](../LOCAL_REFERENCES.md).

History cleanup removes all historical PDF paths, all previous screenshot PNGs
and captured frame text, and replaced vendor prose citations. Fresh original PIO
captures are added only in the sanitized current tree. The rewrite changes commit
IDs; an old checkout must not be merged or pushed back into the cleaned history.
Use a fresh clone for public contributions and move only individually reviewed
original code changes across. Keep private references outside that clone.

The GitHub surface audit found one unprotected main branch and no tags, releases,
pull requests, forks, Pages site or Actions artifacts to clean. Remote main is
updated only with an exact expected-old-SHA lease, protecting concurrent work.
The exact published tree and reachable history must be checked again after push.

GitHub may retain unreachable objects or cached old-commit views outside branch
history. Rewriting a branch does not prove physical deletion from GitHub storage
or other people's clones. GitHub documents that cached-reference removal is a
separate server-side process and that Support does not normally purge
non-sensitive data. See [GitHub's removal limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository#about-removing-sensitive-data-from-a-repository).
Any observed cached exposure must be reported separately; this cleanup makes no
claim to have erased storage controlled by GitHub or third parties.

## Validation

The public unit suite passed 136 tests and explicitly skipped 123 private-source
or optional-backend cases. With all 34 hash-validated private originals and both
HDL flags enabled, the full suite passed 260 tests with no skips. Both public and
private installed-package acceptance passed, including exclusions while private
references were available. Separate real-backend HDL and observer-debug suites
and terminal checks passed. Source-free verification also exercised synthetic
PDFs, both terminal sizes and native coding-agent handoffs. These results verify
the implementation and distribution scope; they do not establish publisher
redistribution permission or hardware fidelity.

## GitHub publication check

A fresh clone verified the entire sanitized history and contained only four
binary blobs, all original PIO screenshots. Its full reachable object graph
contained no PDF signatures or removed long prose citations. The GitHub API
reported no additional branches, tags, releases, pull requests, forks or Actions
artifacts containing another published copy. The fresh clone passed source-free
verification (136 tests passed, 123 explicitly skipped), installed-package
acceptance, both terminal sizes, coding-agent handoffs and the release license
gate.

A post-push HTTP HEAD probe confirmed that the current-main PDF URL returned
404, while a URL containing the pre-rewrite commit ID still returned 200. This
is an observed GitHub cache/unreachable-object exposure, not a cleaned branch
reference. It remains outside the Git history rewrite. No server-side erasure
is claimed, and no repository deletion or Support request was performed.
