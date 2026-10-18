# LicensingProvenance — Soldat browser revival

Research date: 2026-10-15. This is evidence-based engineering/licensing triage, not a legal opinion or a trademark-clearance certificate. Reference repositories were not modified. Research downloads and a reproducible comparison script are under `/tmp/soldat-research/LicensingProvenance/`.

> Historical licensing/provenance triage. [SPEC](../../SPEC.md), [porting status](../porting-status.md) and [PLAN](../../PLAN.md) define current requirements, implementation/qualification and release sequencing. The name/art policies and unchecked checklist below are recommendations recorded on the research date, not evidence of today's branding, clearance or release compliance. Original-source findings and attribution/license cautions remain applicable evidence; implementation does not resolve missing permissions or chain-of-title evidence.

## 1. Verified facts

### 1.1 Code: MIT is the default, not a whole-tree warranty

- `reference/opensoldat/LICENSE.md:1-10` is MIT, copyright 2001–2020 Transhuman Design and 2020–2023 OpenSoldat contributors. It permits commercial use, modification, distribution and sublicensing, with the copyright and permission notice retained in copies/substantial portions. It does not require publishing the entire browser game's source.
- **Important in-scope exception:** `reference/opensoldat/shared/Vector.pas:1-65` identifies Direct3DX/JEDI-derived code and expressly offers **MPL 1.1 or alternatively LGPL**, not MIT. A literal TypeScript translation cannot safely be labeled wholly MIT merely because the repository root is MIT. Independently implementing elementary vector operations from their mathematical definitions is the boring recommended route; alternatively preserve the applicable license and meet its obligations. Whether individual short expressions are copyrightable is jurisdiction/fact dependent, not something this review decides.
- **Important non-open exception:** `reference/opensoldat/shared/libs/KrakenSDK/COPYING:1-7` says NanoKraken/Fae files and submitted binaries are **not contributions** under the contributor agreement and are supplied under **arbitrarily revocable permission** by Softwific UG. Do not port, bundle, or rely on that anti-cheat SDK for a freely redistributable web game.
- `reference/opensoldat/3rdparty/pascalscript/LICENSE.md:5-13` is a permissive custom notice, **not ordinary MIT/zlib**. Besides origin/change marking and retaining the notice in source distributions, it requires a **visible about-box or documentation line saying the program uses RemObjects Pascal Script and where it can be found**. This applies if actually including/adapting that component; a new Node server without Pascal scripting does not need to ship it.
- `reference/opensoldat/3rdparty/SDL2-for-Pascal/README.md:76-80` offers **MPL or zlib** for the bindings. `.../zlib-LICENSE:2-12` permits commercial use, requires accurate origin/change marking and preservation of the notice in source distributions; attribution in product documentation is appreciated, not required under the zlib choice. This is not a reason to carry SDL bindings into a TypeScript implementation.
- `reference/opensoldat/client/libs/dglOpenGL/LICENSE:1-20` is **MPL 2.0**. Avoid copying native rendering bindings into the browser implementation. The root MIT label is not an SBOM.
- This review examined the named dependencies and relevant shared/gameplay source headers, not every vendored source file or binary. Dependencies actually incorporated into a future WASM/native build need their own complete inventory; those not shipped or translated do not become obligations of an unrelated TS replacement merely because they were in a reference checkout.

### 1.2 Base assets: explicit CC BY 4.0 grant, with a separately licensed font

- `reference/base/README.md:23-29` expressly licenses base content **CC BY 4.0** and links a credits list. `reference/base/LICENSE.txt:133-145` grants worldwide, royalty-free, non-exclusive, irrevocable reproduction/sharing/adaptation rights; commercial reuse is allowed: <https://creativecommons.org/licenses/by/4.0/>.
- This is not merely an inference from GitHub's license detector. On **10 June 2020**, creator `gitMM` said “Let's do creative commons” and linked CC BY 4.0 in the asset-licensing discussion: <https://github.com/opensoldat/base/issues/6#issuecomment-641793321>. The license was committed **13 July** and merged **14 July 2020**: <https://github.com/opensoldat/base/pull/12>. Therefore **25 May 2020 is the source announcement date, not the date the explicit CC asset license first landed**.
- A conflicting generic “all rights reserved” README sentence was deliberately removed in 2022 “to avoid confusion about licensing”: <https://github.com/opensoldat/base/commit/dbd78ebf3681b6309495b6fcaa23f1c7ad1076b1>. Historical shareware text existed alongside the assets before cleanup; do not mistake that history for revocation of CC BY.
- `reference/base/Credits.md:1-4` describes itself as a **“(very) Incomplete”** credits list. It identifies AEfremov for berserker/flamer/predator/medikit art and pewpew / BranDougherty for friend/mic/connection icons. This is not a complete authorship ledger for maps, sound and graphics.
- **Font exception verified from the actual binary:** `reference/base/play-regular.ttf`, 171,084 bytes, identifies **Play**, version **1.002**, copyright 2011 Jonas Hecksher / Playtype / e-types AS; its TrueType `name` IDs 13–14 say **SIL OFL v1.1** and link the OFL. It is byte-identical to the font in the official 1.7.1.1 installer. Thus **do not relicense the font as CC BY or MIT**.
- Upstream Play OFL text: <https://raw.githubusercontent.com/google/fonts/main/ofl/play/OFL.txt>. It permits web embedding and redistribution with a game, requires retaining font copyright/license, prohibits selling the font alone, keeps font derivatives OFL, and reserves **Play**, **Playtype**, **Playtype Sans**. These restrictions do not make the game itself OFL. WOFF/WOFF2 compression can avoid being a modification only when original data and relevant metadata are preserved; subsetting is ordinarily modification: <https://openfontlicense.org/ofl-faq/#2-using-ofl-fonts-for-webpages-and-online-webfont-services>. Safest starting point: ship the existing unmodified TTF plus its OFL notice.
- `reference/base/shared/txt/font-help.txt:4-5,19` also refers to **Lucida Console** as an installed font choice. That is not a license to redistribute Microsoft's font. No Lucida font file was found in the base root font inventory; use Play or a browser/system fallback instead of acquiring and bundling Lucida by assumption.

### 1.3 Music, community maps, sound: included, but credits/chain-of-title are incomplete

- Base includes `shared/sfx/modules/bloody.xm`, `gore.it`, `necro.it`. All three are **byte-identical** to the official 1.7.1.1 files. The original manual credits **BSG** for **Bloody Soil, Gore, Necromancide**: <https://opensoldat.github.io/manual/manual.html#license>; the actual extracted installer manual at `/tmp/soldat-research/LicensingProvenance/classic/app/manual/manual-en.html:2736-2737` has the same credit.
- No music-specific or sound-specific exclusion from base's CC BY grant was found in the inspected current README, license, credits or license discussion. Do **not** claim music is known proprietary just because BSG is a separate credited author. Equally, the repository does **not** supply signed per-author relicensing/assignment records. The public grant is usable evidence; a complete chain-of-title warranty is not established.
- Community map authors are real and should not disappear behind “all assets by MM.” The original installer manual credits **ctf_Ash** (and Bigfalls, Daybreak, inf_Moonshine, Blox, ctf_Snakebite, Island2k5) to **chakapoko maker**, Tropiccave to Avarax, Factory to viggoloniggolo, ctf_Equinox to Doggfather, htf_Arch to Sticky, and numerous maps to grand_diablo, among others: extracted `manual-en.html:2739-2765`; current public manual also contains community credits: <https://opensoldat.github.io/manual/manual.html>.
- Graphical contributors **Monster** and **L[one]R** are credited in the official 1.7.1 release post: <https://www.soldat.pl/en/post/soldat-1_7_1-release>. Preserve current base credits and relevant known historic credits; obtain additional provenance for any new community submissions.
- Copyright licenses grant only rights the licensor has authority to license (`reference/base/LICENSE.txt:103-110`), and disclaim title/non-infringement warranties (`:284-295`). This makes provenance curation worthwhile, especially before significant commercial distribution. It is not evidence of an actual infringement claim.

### 1.4 Source-release scope and the sequel are unambiguous

- Official post **“SOLDAT 1.8 SOURCE CODE RELEASED!”**, dated **25 May 2020**: <https://www.soldat.pl/en/post/soldat-open-source>.
- The linked primary Steam announcement can be read completely through Steam's public news feed: <https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=638490&count=10&maxlength=0&enddate=1590451200>. Announcement title: “Soldat 1.8 has been released as open source!” It explicitly says the public **1.7.1** is **different from open-source 1.8**, and 1.7.1 source was available **on request for people joining the official dev team**, not as the announced unrestricted public release.
- That announcement lists 1.8 differences: FreePascal rather than Delphi 7, cross-platform support, SDL/OpenAL/GameNetworkingSockets/PhysFS, old GUI removed and needing replacement, cvar configs, major refactoring; changes could not be easily merged. `reference/opensoldat/README.md:7-9` still calls this the unfinished “so-called 1.8 version.” The checked-out OpenSoldat tree also includes later community changes.
- **Soldat 2 is a separate sequel, not the name of the open-source 1.8 line.** The 2020 announcement ends with MM returning to work on Soldat 2. Its current Steam listing names Transhuman Design as developer/publisher, release **22 September 2020**, and says “Soldat 2 and Soldat is Copyright © Transhuman Design, All Rights Reserved”: <https://store.steampowered.com/app/474220/Soldat_2/>. No Soldat 2 code/art license is conferred by either reference repository.

### 1.5 Classic download availability and actual bundled terms

- Official downloads page still lists **1.7.1.1 (105 MB)** and dedicated server 2.8.2: <https://www.soldat.pl/en/downloads>. Its `/en/download/...` link returned HTML, not a ZIP in this research; the official static archive works:
  - <https://static.soldat.pl/downloads/soldat1711.zip> — **109,973,821 bytes**, downloaded and installer extracted without running the game.
  - SHA-256: **`affbd397a6498e678c6974db3326a9639f414708a53fabec34ffb6db96ae6bc5`**.
  - <https://static.soldat.pl/downloads/soldat171.zip> — 1.7.1 also remains listed in the official archive, 107,756,617 bytes: <https://static.soldat.pl/downloads/>.
- The **actual 1.7.1.1 installer** contains a legacy `app/readme.txt`, copyright MM 2001–2016, calling the game **shareware**, not an MIT distribution (`/tmp/.../classic/app/readme.txt:2-5,33-37`). The current public manual calls it **freeware** but retains the restrictive distribution wording: <https://opensoldat.github.io/manual/manual.html> (“License and distribution”). These are stale/inconsistent labels for a free-to-play product, not grounds for treating the whole installer as open source.
- Actual installer `readme.txt:43-58` permits **exact, unmodified copies of the unregistered shareware package and documentation**, at no charge, and forbids redistribution of registered copies. `:62-76` prohibits modification/reverse engineering as written; allows modified graphics/sounds as free game mods but expressly excepts maps/scenery; prohibits renting/selling the software except server rentals or special permission. Enforceability of a reverse-engineering prohibition depends on applicable statutory exceptions; this review does not resolve it.
- **Answer to “can we redistribute 1.7.1 files?”:** the bundled terms support mirroring the qualifying **complete unmodified unregistered release**, not wholesale extraction, repackaging, relicensing or commercial sale of arbitrary installer files. For matching assets available in the CC BY base repository, obtain them there and preserve that provenance/license; a work can have a separate permissive grant despite old package notices. For classic-only DLLs, demos, old maps or other material absent from base, establish a separate license or permission before serving them.
- The similarly named `https://static.soldat.pl/downloads/license.txt` is the **Inno Setup installer tool's license**, not a permissive license for Soldat. Do not use it as evidence to relicense game files.

### 1.6 Measured base-vs-classic identity: all shipped maps, not all artwork

Compared the actual extracted official 1.7.1.1 client and official server archive against local base commit **`5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4`**. Research comparison script: `/tmp/soldat-research/LicensingProvenance/compare-provenance.py` (provided for reproducibility; primary measurements were performed directly in the research session).

**Maps:** client contains **97 `.pms`**; base contains **99**. **All 97 client maps are present and byte-identical**. The official server package independently contains the same 97, also all byte-identical to base. Base extras are **ctf_Aftermath.pms** and **ctf_Amnesia.pms**. Base breakdown is **34 CTF + 29 unprefixed/DM + 19 HTF + 17 INF = 99**. Therefore **ctf_Ash and every shipped 1.7.1.1 inf_* map are included**. This does not extend to every custom map ever produced or every map revision from earlier Soldat releases.

Same-relative-path comparisons below are case-insensitive; counts include non-image helper files within each category. Different bytes are not automatically different gameplay or redrawn pixels.

| Category | Classic files | Base files | Same paths | Byte-identical at same path |
|---|---:|---:|---:|---:|
| `.pms` maps only | 97 | 99 | 97 | **97** |
| animations | 51 | 51 | 51 | 0 as raw bytes; **50/51 after CRLF normalization** |
| gostek-gfx | 126 | 126 | 126 | 121 |
| weapons-gfx | 107 | 106 | 106 | 106 |
| sfx incl. modules | 167 | 167 | 164 | 164 |
| textures | 93 | 89 | 86 | 85 |
| scenery-gfx | 488 | 447 | 403 | 389 |
| sparks-gfx | 72 | 72 | 72 | 72 |
| interface-gfx | 47 | 50 | 47 | 47 |

- The one animation differing beyond line endings is **stunt.poa**; history explicitly records “Normalize stunt animation” (5 September 2021): <https://github.com/opensoldat/base/commit/0d1d63505d5c>.
- Pillow RGBA comparisons found actual changed pixels in four same-path head sprites (`morda.png`, `morda2.png` and their `team2/` counterparts), 14 same-path scenery PNGs and the medikit texture. Thus base is **not** a pristine 1.7.1.1 asset snapshot. Names removed/added also matter; do not infer complete graphics identity from map identity.
- History adds/revises AEfremov kit art in 2022, confirmed by `reference/base/Credits.md:3` and <https://github.com/opensoldat/base/commit/0330a709919a8a8b0bf66368feb5429834eef81a>. Other changes include missing scenery fixes and deletion of duplicate BMPs; history: <https://github.com/opensoldat/base/commits/master/>.
- Even the 1.7.1.1 originals are already a **partly remastered HD art set**, not the 2002 pixel-art set. Official 1.7.1 release says 1.7 introduced HD graphics and 1.7.1 added more scenery/player models in “4K HD”: <https://www.soldat.pl/en/post/soldat-1_7_1-release>. The 1.7.0 changelog explicitly mentions HD graphics, 4.5× upscaling of some weapon/spark art, alpha conversion, and switching to Play: <https://opensoldat.github.io/manual/changelog.html>.

### 1.7 Soldat name/logo: active proprietary brand; registration status not verified

- Original manual names **Michał Marcinkowski as inventor/owner**; official press kit calls him “Inventor, Project Owner & Business Manager”: <https://pr.thd.vg/sheet.php?p=soldat>. Current Soldat Steam page names **Transhuman Design + Soldat Team** as developers, **Transhuman Design** as publisher, and claims copyright © 2001–2020 THD, all rights reserved: <https://store.steampowered.com/app/638490/Soldat/>. Soldat 2 remains marketed under the same publisher/franchise.
- This is good evidence of the brand's commercial source/claimant (**THD/MM**), **not a verified chain of trademark title or registered proprietor**. I found no specific Soldat game registration number/certificate in indexed searches of USPTO/Justia, EUIPO, WIPO and Polish patent-office domains, including owner-name searches. This is **unknown**, not “the trademark is unregistered.” The official EUIPO discovery page points to eSearch/TMview for actual records: <https://www.euipo.europa.eu/en/search-ip>. An indexed-web search is not an exhaustive registry clearance in any jurisdiction.
- Lack of a found registration is not permission. USPTO explains use can establish trademark rights even without registration: <https://www.uspto.gov/trademarks/basics/what-trademark>. Other jurisdictions have their own rules.
- CC BY **expressly excludes patent/trademark rights**, `reference/base/LICENSE.txt:199-200`, and forbids suggesting endorsement/official status, `:182-187`. The MIT copyright license is not a franchise-brand authorization either.
- The press kit supplies a logo for press coverage but no license granting an unrelated game official-looking product branding was found. A logo file's presence in an art pack would not itself grant trademark rights. Attribution to Soldat and descriptive compatibility references are different from naming a competing product “Soldat” or using the original logo as its app icon.

### 1.8 User-supplied maps/mods: format compatibility is not content permission

- A browser can implement `.PMS`/asset import independently of whether the service has rights to distribute each input. **Serving** user uploads to other players is reproduction/distribution/public communication; “the uploader supplied it” is not a blanket license.
- Safe architectural split: **local-only import/preview** (files stay in that user's browser) vs. **public hosted content** (explicit rights declaration, applicable license, retained attribution/source/change info, and takedown procedure). Local-only avoids our public redistribution, but does not create rights the user lacks; exact legal duties depend on jurisdiction.
- For public map/mod hosting, require the uploader to own rights or identify a license allowing hosting, browser conversion and redistribution of **the map plus every dependency**. A custom map may use textures/scenery/audio from third parties with different permissions. Engine MIT and base CC BY do not automatically license all user creations.
- Other projects are not clearance evidence. The existing browser port itself warns its distributed asset folders combine CC BY base and proprietary freeware/older-release files, and recommends omitting the `--v171` overlay to build a freely shareable pack: <https://github.com/humanova/soldat-web#credits-and-license>. That warning corroborates the need for a curated clean base, not permission to copy its mixed pack.

## 2. Research assumptions: claim / verdict / evidence

| Claim | Verdict | Evidence / correction |
|---|---|---|
| Source was publicly announced 25 May 2020 | **Confirmed** | Official soldat.pl post and primary Steam news feed, §1.4. |
| The public source is unfinished 1.8, not untouched 1.7.1 | **Confirmed** | README:9 and explicit Steam announcement. |
| “The source uses MIT” means everything in the checkout is MIT | **Nuanced / refuted if blanket** | Root MIT, but Vector MPL1.1/LGPL, PascalScript custom terms, SDL dual license, dglOpenGL MPL2, Kraken revocable permission. |
| “Assets are CC BY 4.0” | **Confirmed for declared base content; nuanced** | README:23-29, creator approval and merged license; Play is OFL and author ledger incomplete. |
| Assets were all open-licensed on the source-announcement date | **Refuted** | Creator CC consent June 10; license merged July 14 2020. |
| CC BY permits commercial browser redistribution/conversion | **Confirmed, conditions apply** | License §§2–3; retain credits/source/license/disclaimers, changes, no downstream restrictions, no endorsement. |
| Base assets are identical to classic 1.7.1.1 assets | **Refuted as a whole** | Measured pixel/byte changes, kit replacements, new icons and scenery changes. |
| Classic shipped maps such as ctf_Ash and inf_* can be sourced from base | **Confirmed** | **97/97 client PMS byte-identical**, 99 in base. |
| “Original assets” necessarily means original 2002 appearance | **Refuted** | 1.7/1.7.1 introduced HD/remastered/upscaled assets. User must choose era. |
| Classic 1.7.1.1 can still be downloaded | **Confirmed** | Official static ZIP downloaded/extracted, pinned SHA-256; main page link itself returned HTML. |
| Freely downloadable 1.7.x installer means its arbitrary files may be repackaged in our web game | **Refuted** | Actual installer restrictive shareware distribution terms; use separately licensed base equivalents. |
| Original trademark rights are not included | **Confirmed** | CC BY §2(b)(2); no separate brand authorization located. |
| Soldat is a registered trademark owned by THD | **Unknown as a registration claim** | Brand claimant supported, no verified registry record/number or chain of trademark title found. |
| Music or community maps are expressly excluded from base's CC grant | **Not supported** | No such exclusion found; actual author names/provenance still need retaining. |
| User-uploaded maps/mods can be publicly served just because importer supports them | **Refuted** | Permission needed for hosted content/dependencies; separate local-only import from hosting. |
| Soldat 2 art/code is covered by the open Soldat release | **Refuted** | Separate commercial sequel and all-rights-reserved listing. |

## 3. Hidden assumptions and whether they hold

1. **A single `LICENSE` at project root is enough:** false. At minimum distinguish new/ported code, CC assets, OFL font, possible MPL-derived files, and hosted community content.
2. **Credits.md is a complete attribution manifest:** false by its first sentence. Known older creator credits (including BSG and map authors) exist elsewhere and should be carried forward.
3. **A CC license is a title/non-infringement warranty:** false; expressly disclaimed. No evidence of a dispute was found, but grant scope is limited by actual ownership.
4. **Transcoding/atlasing is prohibited or demands author permission:** false for CC base. Technical media/format changes are explicitly authorized (`LICENSE.txt:155-165`); pure technical changes alone are not necessarily Adapted Material. Still documenting conversion is useful and satisfies a conservative change-notice policy.
5. **CC BY forces our entire code to be open or forbids monetization:** false. No NC or SA condition. Do not impose a game EULA that removes recipients' CC asset rights.
6. **Artwork that says “Soldat” can become our favicon/title logo automatically:** false for trademark/endorsement purposes.
7. **One base pack exactly preserves every historical Soldat look:** false. 1.7-era HD and later OpenSoldat changes are distinct from earlier graphics, even where map geometry is identical.
8. **Old manual's assertion of copyright in file formats prevents writing a PMS parser:** not established. Implementing interoperable format behavior is not the same as copying protected assets/software. The grant covers base content and technical adaptation; broader format-protection questions are jurisdiction-dependent. Do not copy that sweeping historical sentence into our own notices as a legal conclusion.
9. **We must port native anti-cheat/scripting as part of faithfulness:** false for the stated gameplay goal. Excluding native SDKs is both technically sensible and legally cleaner; game-feel fidelity does not require their proprietary code.

## 4. Risks and mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| **High** | Publishing a Soldat-branded/logo-identical game implies official affiliation; trademark clearance absent | Independent public title/logo; descriptive Soldat compatibility only; conspicuous unofficial disclaimer; get THD/MM written permission for Soldat-primary branding. |
| **High** | Pulling arbitrary 1.7.x installer files or a mixed third-party web asset pack into distributable web content | Allowlist base-derived files with commit/hashes; keep proprietary classic reference install separate; obtain permission for any classic-only extras. |
| **High** | Treating Kraken/Fae as MIT or carrying it into WASM | Exclude SDK/binaries completely; new server authority/anti-abuse design is separate work. |
| **Medium** | Literal Vector translation loses MPL/LGPL notice and obligations | Independently implement elementary math; or isolate/adopt appropriate license and provide required source/notices after focused legal review. |
| **Medium** | Missing BSG/community map/remastered art credit due to four-line Credits.md | Per-file manifest; retain known legacy authors; link complete credits; ask maintainers for missing author information rather than inventing it. |
| **Medium** | Community asset chain-of-title incomplete | Preserve public creator CC approval and pinned repo notices; seek maintainer clarification for material commercial launch, especially music/third-party scenery; replace contested content if needed. |
| **Medium** | Public upload service distributes unauthorized map dependencies | Explicit submission license and rights declaration; moderation/report/takedown flow; separate local preview from public distribution. |
| **Medium** | Game EULA/cache/CDN downloads accidentally strip CC or OFL notices | Ship license/credit manifest in both website and downloadable/offline asset bundles; carve licensed content out of restrictive terms. |
| **Low** | Font optimization renames/subsets Play incorrectly | Initially serve unmodified 171 KB TTF plus OFL; if converting/subsetting, preserve metadata or rename per OFL rules. |
| **Low** | Selecting latest base silently changes nostalgia target | Pin asset commit; record classic-vs-base changes; name target era explicitly in fidelity spec. |

## 5. Concrete recommendations / spec decisions

The policies and checklist below preserve the 2026-10-15 recommendations. They do not select a new public title or art baseline, or report completion of a current release audit.

### 5.1 Default legal/content policy

1. **Ship a curated base-derived pack**, pinned initially to `5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4`, under CC BY 4.0. It already supplies **all 97 original 1.7.1.1 maps**, so no proprietary installer overlay is needed to meet that map-content criterion.
2. Define an explicit **99-map base catalog / 97-map classic shipped subset**; keep base-only Aftermath and Amnesia distinguishable in metadata. Support other PMS files as an import-format capability, not a promise that every historical/custom file is distributable by us.
3. Define “original art” as a chosen era. Recommended initial implementation baseline is **1.7.1.1-compatible appearance using the licensed base art**, with a recorded delta list—not a false claim that current base is byte-identical to the 2002 or 2016 release.
4. Keep official classic installer solely as a **reference fixture** outside distributable web assets unless exact unmodified mirroring is intentionally provided under its legacy terms. Never include its DLLs, registered keys or arbitrary older maps under our MIT/CC labels.
5. New project-authored TS can be MIT if desired; preserve upstream MIT notices for translated code. Exclude Kraken, native rendering bindings and PascalScript unless independently justified. Decide Vector handling **before** literal source translation.
6. Use Play's **171,084-byte unmodified TTF** with **OFL 1.1** and its notices. Do not bundle Lucida Console.
7. Music in base can be handled under its declared CC grant with **BSG** credit; do not present chain-of-title as audited. For a commercial launch, seek confirmation from upstream for legacy third-party music/scenery authorship. This is a risk-control recommendation, not a claim that an additional permission is always legally required despite an existing valid grant.
8. Include provenance fields in the content catalog: source repo/commit/path, SHA-256, creator/credit, license identifier + text/URL, original-title, changes, derived bundle IDs. This is small data work, not a new runtime abstraction. Licenses should not be inferred from filename extensions.
9. No tick-rate/network/LOC figures are determined by this legal slice; those belong to simulation/network reports. Relevant measured sizes/counts are above.

### 5.2 Recommended project name policy

- Internal working folder/research codename **`soldat-web`** can remain descriptive; **do not assume that codename is a cleared public product brand**.
- **Default public release: a distinct original title and original icon/logo**, not “Soldat”, “Soldat 3”, “Soldat Remastered”, or “Official Soldat Web”. A new proposed title itself needs clearance before launch; this report does not invent a supposedly cleared name.
- Use factual secondary wording such as **“An unofficial browser recreation using open-licensed Soldat/OpenSoldat content”** and **“Supports Soldat .PMS maps”**, proportionate to the compatibility actually demonstrated. Do not claim compatibility with original servers, which is explicitly out of scope.
- Put an accessible disclaimer next to About/credits and on the landing page: **“Independent project; not affiliated with or endorsed by Transhuman Design or the OpenSoldat team.”** A disclaimer reduces ambiguity but is not a substitute for permission or automatically a defense to confusing branding.
- Refer accurately to original creators/rights claimants: **“Soldat was created by Michał Marcinkowski. Original Soldat copyright Transhuman Design; OpenSoldat contributions by their respective contributors.”** Do not add an **®** or assert a registered mark without a verified registration. Do not imply ownership of the Soldat mark transferred with the source.
- Obtain **written THD/MM authorization** defining title/logo/domain/store-listing scope before making Soldat the primary product name. Obtain appropriate permission for OpenSoldat branding separately rather than assuming that prefix is a free brand license.

### 5.3 Attribution checklist for a browser game

**User-visible and downloadable:**

- [ ] Provide a **Credits & Licenses** link from the landing/menu UI and an **About** entry during gameplay. It must be available without joining a match; a permanently reachable web page can satisfy CC attribution reasonably for this medium (`LICENSE.txt:246-251`). A visible credits screen is a recommended implementation, not a magical license-mandated screen name.
- [ ] Credit **Michał Marcinkowski / Transhuman Design**, **OpenSoldat contributors**, named asset contributors in current Credits.md, **BSG** for the three tracks, and relevant known map/art creators. Do not replace all authors with “us” or a generic © line.
- [ ] Link to the exact **base repository revision/source** and **CC BY 4.0**; retain supplied copyright/license/warranty notices. Preserve current Credits.md and known previous credit/change information in an accessible manifest.
- [ ] Say what our pipeline changed: e.g. **“Sprites packed into atlases; alpha/color-key handling converted; audio transcoded for browsers; PMS data interpreted without map edits.”** Add actual content/gameplay changes separately and do not claim source maps were untouched if edited. CC technical conversion alone need not constitute Adapted Material, but a transparent notice is low-cost.
- [ ] Include full upstream **MIT notice** for translated substantial code, in source and a served/distributed third-party notice asset; ensure minification does not strip the only surviving notice.
- [ ] Include **Play copyright + SIL OFL 1.1** with the font and on license page. Do not label font files CC BY. Check reserved-name conditions if font is altered.
- [ ] If including PascalScript, add the specifically required visible **“made using RemObjects Pascal Script” + source URL** line, retain license/source notices, mark changes. If not included, do not falsely list it as a dependency.
- [ ] If any MPL-derived source survives, preserve its license/headers and required source availability; do not flatten everything into MIT. Prefer avoiding native bindings and independent elementary math implementation.
- [ ] Include credits/licenses/manifest in **downloadable map packs, atlases/offline caches or export archives**, not only on a development repository that players never see.
- [ ] Ensure website/game terms explicitly preserve **CC asset and OFL font rights**. Do not impose extra restrictions or effective technical measures that prevent exercise of the licensed CC rights (`LICENSE.txt:167-180`). Ordinary HTTP compression/cache integrity is not itself evidence of prohibited DRM.
- [ ] For community content, retain author, source, license, required notices and modification records **per map and per dependent asset**; distinguish hosted licensed content from local-only imported files.
- [ ] Keep factual original-brand credit separate from our product branding and include non-endorsement wording. Attribution must not imply sponsorship.

Suggested compact asset-credit entry (expand author list/changes from the manifest):

> Soldat/OpenSoldat base content — original Soldat by Michał Marcinkowski / Transhuman Design, with community contributions; licensed under CC BY 4.0. Source: opensoldat/base at [pinned commit]. Browser adaptations: [actual changes]. Music: “Bloody Soil”, “Gore”, “Necromancide” by BSG. Additional authors and notices: [Credits & Licenses]. No endorsement is implied. Play font © 2011 Jonas Hecksher / Playtype / e-types AS, SIL OFL 1.1.

## 6. Product questions recorded at research time

1. Which nostalgia baseline is intended: **original early-2000s low-resolution art**, **1.7.1.1 HD appearance**, or the **current OpenSoldat base**? The map subset is available in base, but the artwork is not identical across those choices.
2. Is **Soldat as the primary public name/logo** essential, and is the user willing to seek written brand authorization, or should the product use an independent identity?
3. Is this intended to be **public/commercial/monetized**, and in which target jurisdictions? Those choices determine the proportionate scope of professional trademark/provenance clearance; they do not cancel MIT/CC permissions.
4. Should users be able only to **import locally**, or also **publish maps/mods for everyone**? Public hosting has separate rights/attribution/takedown requirements and should not accidentally be implied by file compatibility.
