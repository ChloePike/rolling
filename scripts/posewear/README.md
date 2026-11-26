# PoseWear import (D-004)

Scripts that turn PoseWear (https://posewear.pages.dev/) into the public library:
metadata snapshot, D1 SQL, and an R2 copy. The mapping logic lives in
`packages/core/src/library/` (pure TS, Workers-safe); these scripts only do I/O.

```sh
T=packages/core/node_modules/.bin/tsx
$T scripts/posewear/fetch.ts            # out/snapshot.json + out/summary.json (+ size estimate; --no-sizes to skip)
$T scripts/posewear/emit-sql.ts         # out/import.sql, out/sql/import-*.sql, out/r2-plan.json
$T scripts/posewear/copy-to-r2.ts --dry-run                              # plan only, no network
$T scripts/posewear/copy-to-r2.ts --dry-run --fetch-source --limit 5     # fetch 5 sources into memory, discard
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... R2_BUCKET=rolling-media-staging \
  $T scripts/posewear/copy-to-r2.ts --category pose,pose_depth,outfit,outfit_anime,outfit_historical
```

`out/` is git-ignored. `labels.json` is translation data (source label to English) for
sub-category values that have no English field in the source.

## Data sources

The homepage loads `/assets/app.<hash>.js`, which holds a tab-to-file map. `fetch.ts`
reads that JS as text (regex, never executed) to find the files:

| Tab | Category | File | Shape |
|---|---|---|---|
| `pose` | `pose` | `/assets/poses.<hash>.json` | array |
| `depth` | `pose_depth` | `/assets/depths.<hash>.json` | `{ pack, items }` |
| `costume` | `outfit` | `/assets/costumes.<hash>.json` | array |
| `anime` | `outfit_anime` | `/assets/anime.<hash>.json` | array |
| `portrait` | `portrait` | `/assets/portraits.<hash>.json` | array |
| `expr` | `expression` | `/assets/expressions.<hash>.json` | array |
| `hair` | `hairstyle` | `/assets/hair.<hash>.json` | array |
| `dyn` | `outfit_historical` | `/assets/dynasties.<hash>.json` | array |
| `scene` | `scene` | `/assets/scenes.<hash>.json` | array |
| `light` | `lighting` | `/assets/lights.<hash>.json` | array |
| `prop` | `prop` | `/assets/props.<hash>.json` | array |
| `furn` | `furniture` | `/assets/furniture.<hash>.json` | array |

`/assets/i18n.<hash>.js` has a zh to `[en, ja]` label table (used as a fallback translator).
`references.<hash>.js` and `extras.<hash>.js` contain no data.

## URL patterns

Image fields: `t` thumbnail, `m` medium, `i` display (large), `o` original.

- `t` relative paths resolve on `https://pwimg.0vo.pro/` (for example `p/t/full_single_P001_front.webp`).
- `i` and `m` relative paths resolve on the site origin `https://posewear.pages.dev/` (`p/i/...webp`). They return 404 on pwimg.
- `o` (`o/<x>/...png|webp`) is on pwimg. `robots.txt` disallows `/o/`, so we do not use originals.
- Absolute URLs are used as given: depth maps (`https://pwimg.0vo.pro/d/thumbs/*.jpg`, `.../d/img/*.png`) and
  CharaDB images (`https://charadb-2fi.pages.dev/thumb/*.webp`, `.../img/*.jpg`).
- Path prefixes per tab: `p` pose, `c` outfit, `a` anime, `r` portrait, `e` expression, `y` historical,
  `s` scene, `l` lighting, `t` prop, `f` furniture.
- Item deep link (our `sourceUrl`): `https://posewear.pages.dev/#<tab>/<id>`. Static item pages
  (`/pose/<id>/`, `/costume/<id>/`, `/anime/<id>/`, `/portrait/<id>/`, plus `/en/...`) exist only for non-adult items.

Pages hosts do not send `Content-Length` on HEAD, so the size estimate falls back to a GET counted in memory.

## Fields per category

Common: `id`, `zh`, `en` (English prompt), `ti` (short zh title), `ja`, `a` (adult flag), `angles[]`.

| Category | Sub-category source | Other fields |
|---|---|---|
| pose | `cat` (zh, via labels.json) | `no`, `line`/`lineEn` (framing, e.g. "full body, solo"), 5 angles |
| pose_depth | `cat` | `catJa`, `lineJa`, `pack`, `credit`, `ref: no-referrer`; angles are depth maps |
| outfit, outfit_anime | `catEn` | `kw` (English keywords), single image `t/m/i/o`; 440 anime items hotlink CharaDB (`ext: 1`, ids `charadb-O###`) |
| portrait | `sec` (front / lifestyle) | `len` (hair length), `st` (zh style), `w`, `h`, `rk`/`rc` (rank) |
| expression | `emoEn` | `intEn` (subtle/strong), `ja` holds a short English name, `code` (blendshape code), 2 angles |
| hairstyle | `cat` | 46 items have 5 hair-colour variants as `angles`; 76 are single images. All hosted on CharaDB |
| outfit_historical | `eraEn` | `gender` (M/F/U), 3 to 4 angles |
| scene | `cat` | `lineEn` (finer group, kept as tag), `light` (appended to the prompt), angles above/eye/below |
| lighting | `cat` | `lineEn`, `setting` (demo setting, not imported) |
| prop, furniture | `cat` | `lineEn`, `dims` (furniture) |

## Angles and depth maps

Angle names are normalized from the English label: `front`, `three_quarter`, `side`, `back`,
`high`, `low`, `eye_level`; hair variants become `brown_hair`, `black_hair`, ...; single-image items get `main`.

`pose` and `pose_depth` share all 288 source ids. A pose's angle gets the depth map of the
depth item's angle with the same view (`depthUrl`), and each item has `counterpartId`.
In the snapshot, all 1,439 pose angles have a depth map. One item has 4 angles; the rest have 5.

R2 keys: `public/<category>/<itemId>/<angle>.<ext>`. The extension follows the source bytes
(webp for most; png for depth maps; jpg for CharaDB) rather than always `.webp`, so objects
are never mislabeled. Change `libraryR2Key` if we transcode to webp later.

## Dev fallback

Every item carries `sourceThumbUrl` / `sourceFullUrl` (cover angle), and every angle has
`thumbUrl` / `fullUrl` on the source CDN. Local dev can render those until R2 is populated;
production should read `r2Key`. Depth images on pwimg want `Referrer-Policy: no-referrer`.

## Licenses

| Category | Source site says | D-004 | Our value |
|---|---|---|---|
| pose, pose_depth, outfit, outfit_anime | "Unofficial compilation. Image rights belong to the original authors; contact them before reposting or commercial use." The upstream galleries (ai-pose-gallery, ai-pose-depth-gallery, ai-costume-gallery, ai-costume-anime-gallery, @giaaibusi) say: free for commercial use in works; redistributing or reposting the image data itself is prohibited; bulk download (including automated retrieval) is prohibited. | First-party | `first-party` |
| outfit_anime, 440 CharaDB items | CharaDB: tags and prompts are OK for commercial use; images are for reference only and cannot be sold inside a work | (not listed) | `cc0`, attribution CharaDB |
| portrait | CC0 1.0, fictional people; author asks not to redistribute the image data | CC0 | `cc0` |
| hairstyle | CharaDB, "marked CC0, image copyright belongs to the original author" | CC0 | `cc0` |
| expression | ICT-FaceKit head model, (c) USC ICT, MIT | MIT | `mit` |
| historical, scene, lighting, prop, furniture | CC0 1.0 (Shisei, wquguru) | CC0 | `cc0` |

Rights notes (status 2026-11-26):

1. ~~First-party vs @giaaibusi's terms~~ Resolved: the owner holds authorization from @giaaibusi
   for the pose, depth-pose, outfit and anime-outfit galleries (D-004).
2. ~~CharaDB images (hairstyles, 440 anime outfits)~~ Resolved by owner decision (D-004, 2026-11-26):
   they are imported too, with license `cc0` and attribution CharaDB (`assets.meta.attribution`,
   GraphQL `PublicItem.attribution`, the details panel shows "CharaDB"). The 4 minor-coded items stay excluded.
   **Not yet copied:** fetching them from charadb-2fi.pages.dev was not run (it needs an explicit go-ahead
   for the bulk download), so staging and production still hold the set without CharaDB (see Live state).
3. Portraits: CC0, but the author asks not to redistribute the images. Copying them to R2 and
   serving them publicly is legal under CC0 but goes against that request (owner accepted under D-004).
4. pwimg.0vo.pro `robots.txt` sets `Content-Signal: search=yes, ai-train=no, use=reference`.

## Live state (2026-11-26)

Staging and production hold the same set: 5,141 items (all categories except hairstyle and the 436
CharaDB anime outfits), 8,074 assets (2,575 mature), 5,141 search rows.

| Bucket | Contents |
|---|---|
| `rolling-public-<env>` (media[-staging].rolling.actor) | 5,499 non-mature library images + 8 template covers |
| `rolling-media-staging` | all 8,074 library images (the copy source) |
| `rolling-media-production` | 2,575 mature library images (signed URLs only) |

Refresh both environments (idempotent):

```sh
T=packages/core/node_modules/.bin/tsx
$T scripts/posewear/emit-sql.ts --include-mature                 # add --exclude-attribution charadb until CharaDB images are in R2
# CharaDB backfill (source CDN -> staging private bucket), when approved:
$T scripts/posewear/copy-to-r2.ts --env staging --target private --include-mature --category hairstyle,outfit_anime
# Public buckets and production private bucket, copied from staging through the copy Worker (copy-worker/):
$T scripts/posewear/copy-to-r2.ts --env staging    --target public  --from-bucket rolling-media-staging --extra-prefix public/templates/ --via-worker $W
$T scripts/posewear/copy-to-r2.ts --env production --target public  --from-bucket rolling-media-staging --extra-prefix public/templates/ --via-worker $W
$T scripts/posewear/copy-to-r2.ts --env production --target private --mature-only --from-bucket rolling-media-staging --via-worker $W
scripts/posewear/apply-d1.sh staging && scripts/posewear/apply-d1.sh production
```

The REST API allows about 4 requests/s for the account, so bulk copies between buckets go through the
temporary `rolling-media-copy` Worker (R2 bindings; deploy, copy, delete). Its public targets refuse
keys the staging catalog marks mature.

## Counts (snapshot 2026-11-25)

| Category | Menu | Source | Mapped | Mature | Public | Images | Est. size |
|---|---|---|---|---|---|---|---|
| pose | 288 | 288 | 288 | 190 | 98 | 1,439 | 51 MB |
| pose_depth | 288 | 288 | 288 | 190 | 98 | 1,439 | 134 MB |
| portrait | 1,499 | 1,499 | 1,499 | 0 | 1,499 | 1,499 | 167 MB |
| expression | 95 | 95 | 95 | 0 | 95 | 190 | 3 MB |
| hairstyle | 122 | 122 | 122 | 0 | 122 | 306 | 56 MB |
| outfit | 1,407 | 1,407 | 1,407 | 340 | 1,067 | 1,407 | 125 MB |
| outfit_anime | 1,760 | 1,760 | 1,756 | 378 | 1,378 | 1,756 | 97 MB |
| outfit_historical | 57 | 57 | 57 | 0 | 57 | 227 | 5 MB |
| scene | 64 | 64 | 64 | 0 | 64 | 168 | 20 MB |
| lighting | 50 | 50 | 50 | 0 | 50 | 108 | 3 MB |
| prop | 32 | 32 | 32 | 0 | 32 | 114 | 2 MB |
| furniture | 41 | 41 | 41 | 0 | 41 | 163 | 3 MB |
| **Total** | 5,703 | 5,703 | **5,699** | **1,098** | **4,601** | **8,816** | **about 666 MiB** |

Sizes come from 20 sampled display images per category, extrapolated. All images: about 666 MiB.
Public-safe images only (6,200 objects in `r2-plan.json`): about 490 MiB. The five priority categories (pose, pose_depth, outfit, outfit_anime, outfit_historical) come to 3,652 public-safe objects, about 240 MiB, or 6,268 objects and about 410 MiB with mature items.
The site's structured data still says "98 poses, 1,068 outfits, 1,380 anime outfits". Those are its non-adult counts.

## Mature content (D-005)

The source has its own adult flag `a`, hidden behind its "18+" switch. It covers couple
poses, "sexy" poses, depth couple poses, lingerie and sexy outfits. We set `mature: true` when:

- the item has `a`, or its pose/depth counterpart has `a`. The two files flag different subsets:
  poses flag 190, depth poses only the 55 couple poses. We use the union, so 190 in each.
- `catEn` is `lingerie` or `sexy`, or `lineEn` contains `sexy` or `couple`
- the text names underwear explicitly (`lingerie`, `underwear`, `bra` but not `sports bra`, `bunny girl`, ...).
  This adds `outfit/AUT-0162`, `outfit_anime/AUT-0162` and `outfit_anime/charadb-O304`.

Pose sub-categories include explicit couple positions. They are all mature. Their English
labels in `labels.json` are written to be neutral.

**Excluded from import entirely:** 4 anime outfits that are flagged adult and described as
school swimsuits (`charadb-O013`, `O209`, `O210`, `O436`). D-005 hard limit: no sexual content
that is coded as involving minors. Rule: mature, and the text matches school/student/child/teen terms.

`emit-sql.ts` and `copy-to-r2.ts` skip mature items unless `--include-mature` is passed. Mature rows get
`public_items.mature = 1` and `assets.mature = 1`; their images live only in the private bucket.

## D1 import

- `assets`: one row per angle. Id `ast_<itemId>_<angle>`, `source 'public'`, `kind 'image'`,
  `r2_key` from above, `license`, `meta` JSON (`publicItemId`, `angle`, source URLs, `mature`).
  `INSERT ... ON CONFLICT(id) DO UPDATE`.
- `public_items`: id `pw_<category>_<sourceId>`, `asset_id` = cover angle asset, `angles` JSON
  `[{ name, label, assetId, r2Key, depthR2Key? }]`, `source` = deep link. Upsert on id.
- `asset_search` (FTS5): one row per item, `name` = en + zh title, `tags` = category, sub, tags and English prompt.
  FTS5 has no unique key, so each batch does `DELETE ... WHERE id IN (...)` and then `INSERT`.
- No `BEGIN`/`COMMIT` statements (D1 rejects them). Each statement inserts 40 rows, and the largest is about 64 KB.
  `out/sql/import-*.sql` holds 400 items per file for `wrangler d1 execute --file`.
- Requires `public_items.license` CHECK to accept `first-party`.

Checked locally: the SQL was applied twice to an in-memory SQLite copy of the three tables. Result: 6,200 assets, 4,601 public_items and 4,601 search rows.

## R2 copy

`copy-to-r2.ts` uses the Cloudflare REST API with a Bearer token:
`PUT /accounts/{id}/r2/buckets/{bucket}/objects/{key}`.
HEAD on an object returns 405, so for resume the script lists each `public/<category>/` prefix
(`GET .../objects?prefix=`), falling back to a GET per key. It first checks that the bucket exists
(`GET .../r2/buckets/{bucket}`), and it refuses any bucket not named `rolling-*`. It never creates buckets.
Each image is held in memory only (no disk) and uploaded with an explicit Content-Type.
Uploads run 4 at a time by default. Failed requests are retried with exponential backoff on 429 and 5xx.
Progress prints every 25 objects, and a report is written to `out/r2-copy-report.json`.
`--env <env> --target public|private` picks `rolling-public-<env>` or `rolling-media-<env>`; public targets
never receive mature objects. Uploads set `Cache-Control: public, max-age=31536000, immutable`.
