# Harness research: prompts per model, shot planning, tools, evals

What the vendors and the open-source video agents do, where our harness differed, what was changed, and the offline scores before and after. Written 2026-11-27. No paid model was called for this work: everything below was verified with the scripted LLM, the golden cases and the recorded live transcripts of 2026-11-25 (`packages/agent/evals/results/`, git-ignored).

Sources are marked **[fetched]** when the page or file was read for this document and **[secondary]** when the claim comes from a third-party summary of a vendor page that could not be read directly. Treat secondary claims as unconfirmed.

## 1. Vendor prompt guides

### 1.1 Video

| Model family | Recommended structure | Length and language | Camera | Speech and sound | Frames and references | Negatives | Mistakes they name |
|---|---|---|---|---|---|---|---|
| **Seedance 2.5** (ByteDance) [fetched] | Asset binding first, then a one-sentence summary ("Subject + Location + Event + Genre/Style + Camera movement"), a detailed plot description (timestamps `0s-3s:` or `Shot N`), then "additional notes" that stay constant | Up to 30 s per clip; native generation in more than 10 languages. No character limit stated | Plain terms work: shot size (extreme wide to close-up), "push in / pull out / pan / track / follow / orbit / tilt up / handheld shake", low angle, overhead, first-person. Niche terms as "term + explanation" | `Character's line (emotion): "content"`. Repeating words after a line or attaching per-word delivery notes triggers burned-in subtitles | Frames by parameter (`first_frame` / `last_frame`, which lock the ratio). References numbered by upload order ("Image 1 depicts the protagonist…"), each with a stated role; do not rely on text written inside the image | No negative prompt. "Use positive descriptions whenever possible"; supported negative controls are subtitles and audio: "No subtitles.", "No BGM; generate only environmental sounds and action sounds." | Strong emotion words cause glowing eyes; wrong character-to-reference mapping when order and numbers disagree; misspelt on-screen text; one task that mixes several reference and edit asks |
| **Seedance 2.0** [fetched] | "precise subject + action details + scene/environment + lighting & color tone + camera movement + visual style + image quality + constraints" | — | Same vocabulary; responds to shot numbers, not timestamps | Quoted lines | Same binding rules | Same | — |
| **Wan 2.5 to 3.0** (Alibaba Model Studio) [fetched] | "Entity + Scene + Motion + Aesthetic control + Stylization"; with sound "+ Sound description (voice / sound effect / background music)"; image-to-video is "Motion + Camera movement"; multi-shot is "Overall description + Shot number + Timestamp + Shot content" | 1,500 characters for 2.5/2.6, cut beyond [secondary, API reference]. English and Chinese | "camera pushes in", "camera pulls out", "camera moves left", "camera tilts up", "orbiting camera movement" (keep orbits under 45°), "fixed camera"; shot sizes, angles, lenses and lighting lists | `X says: "…"` keeps a line exactly; "Voice = lines + emotion + tone + speed + timbre + accent". "No dialogue." and "No background music." switch them off | "Image 1" / "Video 1" identifiers; "Generate single shot." for one take | Not in the guide; the open-source repo ships a default negative prompt | Real people by name, rapid scene changes in one clip, exact text, long action chains, exact lip sync |
| **Wan 2.1 / 2.2 open source** [fetched: `prompt_extend.py`, `system_prompt.py`] | T2V rewriter: style first, then up to four cinematography tags (light source, intensity, angle, shot size, composition), then subject detail, motion described as a process; "do not output literary mood writing". I2V rewriter: "emphasizing potential dynamic content", keep camera moves, "avoid adding static scene descriptions… if the input already describes elements visible in the image, remove those" | T2V 60 to 200 words (2.2), 80 to 100 words (2.1); I2V under 100 words. Separate zh and en system prompts; 2.2 outputs English | "Medium shot", "Close-up shot", "Low angle shot", "Over-the-shoulder shot", "the camera pans up", "the camera pulls back" | none (silent models) | The image is the subject and style; the text is motion | `sample_neg_prompt` in the repo config (overexposed, static, subtitles, extra fingers, …) | Adding people a landscape prompt did not have; mood prose |
| **MiniMax Hailuo / H3** [fetched: vendor camera cheat sheet; secondary for H3] | Camera command where the move happens, the scene, then constants. For H3 [secondary]: a timeline (opening state, ordered action, camera, ending state) | 4 to 15 s [secondary]. No word limit stated | Director bracket grammar `[Push in]`, `[Truck left, Pan right]` (simultaneous), up to three; "recent models read plain language… use one grammar per prompt"; one move for most shots | H3 [secondary]: speaker ids and quoted lines. Our gateway listing has no audio parameter for `minimax/minimax-h3` | First and last frame: describe the path between them, one continuous shot [secondary] | — | Stacked camera labels; a list of looks with no action ("a polished still") |
| **Sora 2** (OpenAI cookbook) [fetched] | Prose scene, then a cinematography block (camera shot, mood), an actions list, dialogue, background sound | Short prompts leave freedom; long ones constrain. "Concise shots": two 4 s clips beat one 8 s clip | One camera move and one subject action per shot; replace "cinematic" with lens and light facts | `Speaker: "line"` block; a 4 s shot holds one or two short exchanges | Image input anchors the first frame; identical phrasing across shots for continuity; name three to five palette colors | — | Vague prompts, overloaded shots, several edits at once, prose that tries to change duration |
| **Runway Gen-4 / 4.5** (Runway Academy) [fetched] | T2V: `[Camera] shot of [subject] [action] in [environment]`. I2V: `The camera [motion] as the subject [action]` | "Over-specification" with multi-paragraph prompts hurts | Handheld, whip pan, push in, locked-off | — | I2V: "Focus almost entirely on motion"; do not restate the image | "Describe what you want to see rather than what you don't want" | Conflicting instructions, ignoring motion implied by the image, unwanted cuts |
| **LTX-Video** [fetched: `prompt_enhance_utils.py`] | "Start with main action in a single sentence", then movements, appearance, background, camera, lighting, changes; one flowing paragraph | 150 words | "Think like a cinematographer describing a shot list" | — | I2V: describe the image first, align the text to it | — | Changing the user's intent |
| **HunyuanVideo** [fetched: `prompt_rewrite.py`] | Rewrite model, Normal and Master modes: "Preserve ALL information", translate Chinese to English, add style, lighting, atmosphere only when missing | Short inputs stay 1 to 2 sentences | — | — | — | — | Losing information in the rewrite |
| **CogVideoX** [fetched: `convert_demo.py`] | LLM expands short prompts to a fixed-length detailed description | Fixed word count ("extra words will be ignored") | I2V: "Don't contain camera transitions… screen switching… perspective shifts" | — | "the output video caption should describe the motion starting from the current image" | — | Camera cuts in one clip |
| **Kling** [secondary] | Concrete visual description, roles assigned to reference assets, I2V is motion only | 2,500 characters for prompt and negative prompt | — | — | `@Image1` style element references | Negative prompt as a term list | — |
| **Veo** | Not read: the Gemini API page now only announces the Veo 3.1 preview shutdown and the Vertex page redirected. No claim is made here | | | | | | |
| **Grok Imagine video** (xAI) [fetched] | No prompt guide. Example prompts are one short sentence | 1 to 15 s; "a prompt that is too long" is an error, no limit given | — | Audio on by default with lip-synced speech; no syntax documented | Text-to-video is text-to-image then image-to-video under the hood; up to 14 reference images | Not mentioned | — |

### 1.2 Image

| Model family | Structure | Text in the picture | References and edits | Negatives |
|---|---|---|---|---|
| **Seedream 4.0 to 5.0** [fetched] | "Use coherent natural language to describe the subject + action + environment", then style, color, lighting, composition. "Concise and precise prompts [are] usually better than repeatedly stacking ornate and complex vocabulary". State the purpose (logo, poster) | "Use double quotation marks" | Say what each image is for ("the character in Image 1", "the style of Image 3"); for edits, name what changes and what stays ("keeping its pose unchanged") | None |
| **Qwen-Image** [fetched: `prompt_utils.py`, README] | Rewriter keeps prompts under 200 words; samples start with the style | Quoted, with position and style, never translated | — | README samples pass a quality negative prompt; the rewriter appends "Ultra HD, 4K, cinematic composition" |
| **Grok Imagine image** | No public prompt guide found | | | |

### 1.3 What the guides agree on

1. **Order**: style or look, subject with visible detail, action, setting, light, camera, then sound. Seedance and Wan differ only in where the scene sits.
2. **One shot is one take**: one camera move, one or two actions; cuts are separate clips (Sora, Wan, CogVideoX, Runway).
3. **With a first frame, write motion**: the picture carries the look; re-describing it wastes the prompt or fights the image (Wan I2V rewriter, Runway, Kling, CogVideoX).
4. **Concrete beats abstract**: lens and light facts, not "cinematic" or mood prose (Sora, Wan 2.2, Seedream).
5. **Speech is quoted and attributed**, about two words a second, and each vendor has its own syntax.
6. **References are bound explicitly**, by upload order and role (Seedance, Seedream, Wan).
7. **Negatives**: a parameter on a few models (Qwen-Image, Wan open source, Kling); everywhere else say what you want, except the documented subtitle and audio switches.
8. **Vendors ship an LLM rewriter** for raw user text (Wan `prompt_extend`, LTX enhancer, Hunyuan rewrite, CogVideoX converter). That is what the gateway's `prompt_expand` is. A prompt that was already written for the model must not be rewritten again.

## 2. Open-source agents and tool design

| Project | What it does | What we take |
|---|---|---|
| **ViMax** (HKUDS) [fetched: arXiv 2606.07649] | Screenwriter, storyboard, character styling, video and a VLM judge. "First generates key images such as character profiles, scene backgrounds, and key frames of shots"; keyframes "require other images such as characters as reference"; a dependency graph orders shots that share characters; best-of-2 keyframes picked by a VLM | Character reference pictures feeding every keyframe; per-shot fields (camera, movement, lighting, positioning, duration); a first-frame description plus a motion prompt per shot |
| **MovieAgent** (showlab) [fetched: README, abstract] | Hierarchical chain-of-thought planning (script, scene, shot) by director, screenwriter, storyboard and location roles from a script and a character bank | A character bank declared once and referenced by name |
| **FilmAgent** (HITsz-TMG) [fetched: abstract] | Director, screenwriter, actor and cinematographer agents with "iterative feedback and revisions" to verify scripts | A critique pass before output. We do it as deterministic server checks plus one self-check instruction, not as extra LLM turns (cost per turn, D-012) |
| **Mora** [fetched: README] | Specialist agents chained per task (text-to-image, image-to-video, extend) | Keyframe then animate as the default path, which we already have |
| **MoneyPrinterTurbo** [fetched: `llm.py`] | Script from a subject, then ordered stock-footage search terms, TTS and subtitles | Narration separate from visuals; lines paced to the voice. Our `line` field and the timeline captions |
| **Vendor rewriters** (Wan, LTX, Hunyuan, CogVideoX) | One system prompt per mode (t2v, i2v) and language | Separate adapters per purpose (clip from text, clip from a picture, still) |
| **Anthropic, "Writing tools for agents"** [fetched] | Few high-impact tools, each with "a clear, distinct purpose"; describe a tool "as you would to a new team member"; unambiguous parameter names; "specific and actionable" errors; return context the agent can use, trim the rest; evaluate with realistic tasks and read transcripts | Tool descriptions rewritten (when to call, what comes back, what the server does); errors that name the fix; no new tools |
| **OpenAI function calling** [fetched] | "Use enums and object structure to prevent invalid states"; "Pass the intern test"; "Don't make the model fill arguments you already know"; "fewer than 20 functions" | Camera size, angle and move are enums; the model no longer writes model-specific prompt text or character descriptors per shot (the server repeats them); 14 tools, unchanged |

ComfyUI prompt and LLM nodes were not studied for this pass.

## 3. Gap analysis and what changed

| # | Best practice | Before | Now |
|---|---|---|---|
| 1 | The prompt is written for the model that runs the job | One free-text `visual` went to every model unchanged | `packages/core/src/prompting`: a `ShotSpec` (subject, action, setting, camera, lighting, style, characters, dialogue, sound, music, text) is composed per family in `buildGenerateRequest`, for the model that actually runs (a fallback model gets its own wording). Families: Seedance, Wan 3.0/Berry, Wan 2.x image-to-video (spicy), MiniMax, Grok video, Seedream, Qwen Image, Z-Image, edit models, Grok image |
| 2 | With a first frame, the prompt is motion and camera | The same full description went to the keyframe and to the clip | Purpose per request: `video`, `animate` (first frame present) or `still`. The animate text is the action, the camera move and speech; the still has no move or sound |
| 3 | A keyframe prompt describes one frame | **Bug**: the script node feeds every keyframe, and its text was every row of the script. Recorded plans sent 180 to 255 words to the image model per keyframe; a scripted 12-shot plan reaches 6,500 characters | A node planned from a shot carries its own row; the script text is not repeated. Free-text nodes behave as before |
| 4 | Recurring characters keep one description | "Same description words every time" was an instruction to the LLM | `characters` declared once per option, `cast` per shot; the server writes the identical descriptor into every shot and refuses a shot that names a character without listing it |
| 5 | Keyframes of a character share a reference picture (ViMax) | Only `@` pictures were wired as references | One "Character: Name" reference picture per character seen in two or more keyframed shots, wired into those keyframes (image edit mode), priced in the estimate; the prompt binds it ("Image 1 is the character Maya: keep the face, hair and outfit identical.") |
| 6 | Camera words the model knows; one move per shot | Free text | Enums for size, angle and move; per-family wording ("The camera slowly pushes in", "Fixed camera", "Slow orbiting camera movement, a small arc…") |
| 7 | Speech in the vendor's syntax, only where it is voiced, paced to the shot | No speech field; `line` was a caption | `dialogue` composed as `Maya's line (calm): "…"` (Seedance), `Maya says in a calm tone: "…"` (Wan), dropped on silent models. The plan is refused when the model has no audio or the words exceed 3 per second; a shot with speech or sound sets `audio` and is priced with it |
| 8 | Negatives where they exist | The node's negative prompt was passed when the model had the parameter | Default quality negatives in the parameter for Qwen Image and the Wan 2.7 spicy route (user's first); "No subtitles." (Seedance), "No background music." / "No dialogue." (Wan) when sound is on; nothing elsewhere |
| 9 | Length limits | None | Hard cap per family; optional parts are cut in a fixed order (lens first, then music, sound and lighting, the setting, the style, last the camera move) and never the subject, action or speech |
| 10 | Do not rewrite twice; do not rewrite what the user typed | — | A typed prompt is passed through byte for byte with no negative prompt added. A composed prompt sets `GenerateRequest.promptComposed`; `prompt_expand` is requested only when it is not set |
| 11 | Mature chain (D-005) | Keyframe = still direction + the prompt; animation = the prompt | With a shot: the keyframe is the shot's still, the animation is motion only with the Wan negative prompt. Typed text is unchanged. Plans for mature-allowed members are checked against the lengths the mature models take (5 or 8 s today), which the run would otherwise block |
| 12 | The prompt box pills are the user's settings | A line in the context | `pillProblems`: ratio, total length, resolution and model are checked on the proposal; only the brief's own words (a ratio, a length, "cheap", a model name) override them. Resolution added to the turn settings |
| 13 | Self-critique before output (FilmAgent) | Schema, lengths, capabilities, balance | Plus cast, speech, pacing, pills and mature lengths as server checks with actionable errors, and a one-line self-check in the prompt |
| 14 | No tool narration in the reply | Forbidden in the prompt; the recorded model still wrote "I'll check the video models…" in 27 to 37% of turns | Text written in the same response as a read tool is never shown, stored or sent back as history (`loop.ts`). The prompt rule is stated first and with examples. Grader `no_narration` |
| 15 | Tool descriptions say when to call and what comes back | One-line descriptions | Rewritten for all 14 tools; parameters carry units, language and examples |
| 16 | Edits change one thing | `updateNode {prompt}` rewrote the whole prompt | `updateNode {shot: {lighting: …}}` is merged over the node's shot; descriptors and other fields stay word for word |
| 17 | Ask only when needed; small talk stays short | In the prompt | Kept and sharpened ("When not to plan"); graded as behavior cases |

Not done, on purpose:

- **No translation.** Composed prompts are English (all families read it); speech stays in its own language inside quotes. Seedance and Wan read Chinese natively, so Chinese typed by a user is sent as typed.
- **No LLM rewrite of typed prompts** in our code: that is the gateway's `prompt_expand` (D-020).
- **Remix, Avatar and Character tool prompts** keep their fixed directions plus the user's words.
- **Best-of-k keyframes with a VLM judge** (ViMax): costs credits per candidate; a product decision.
- **Bracket camera commands for MiniMax**: not confirmed for H3, so plain sentences are used.

## 4. Evals

`packages/agent/evals`: 88 cases (40 original briefs, 31 new: multi-shot ads, short dramas with recurring characters, spoken talking heads, product, holiday, prompt box pills, mature-allowed fictional scenes, hard-limit briefs, small talk, clarifying questions; 6 + 5 canvas edits, 6 timeline edits).

Graders (`graders.ts`), each 0 to 1 per case:

| Grader | Checks |
|---|---|
| `structure` | The existing invariants, plus text-only turns (small talk: no tools, two sentences; clarify: exactly one question; hard limit: neutral message, agent LLM never called; mature off: no explicit proposal) and shot edits that change only the asked fields |
| `shots_structured` | Every shot is fields, and its nodes carry the shot |
| `continuity` | Characters declared; the identical descriptor reaches the prompt that draws each shot; keyframes of a character share a reference picture. Free text gets half credit for a shared four-word phrase |
| `duration_math` | Sum within 10%, whole seconds in the model's range, speech and lines that fit the shot |
| `pills` | Ratio, length, resolution and model follow the prompt box unless the brief says otherwise |
| `prompt_format` | The plan is applied to a canvas, planned as a run and turned into provider requests; every prompt is linted for its family: length cap, word range, language, markup, credit numbers, filler words, negations, more than two camera moves, multi-shot wording, unquoted speech, speech on a silent model, re-describing the picture in an animate prompt |
| `cost_sanity` | Estimate equals its lines; every paid node is priced and feeds something; no keyframe for a text-to-video shot; confirm flag; one option within the balance or the stated budget |
| `reply_text` | No emoji, hype, exclamation marks, false claims, or credit numbers next to a plan |
| `no_narration` | No "I'll check…", "Let me look…", "Checking models" (en, zh, ja, de, es) |
| `mature_routing` | For a mature-allowed member's explicit fictional scene: a plan exists, every explicit run is a mature run on a model that takes one, nothing is blocked |

Run them: `pnpm --filter @rolling/agent eval:score` (scripted), `… eval:score -- --replay <results file>` (recorded transcripts). CI (`evals/ci.test.ts`) requires every grader to pass on every case.

### Scores

Scripted LLM, 88 cases. "Prose" is the scripted agent writing one good free-text prompt per shot (with character descriptions inline), as the previous schema asked; "fields" is the same content as shot fields. The scripted agent narrates its first read ("Checking models.") in both, as the recorded model does.

| Grader (cases) | Before: previous harness, prose | After: this harness, prose | After: this harness, fields |
|---|---|---|---|
| structure (88) | 0.966 | 1.000 | 1.000 |
| shots_structured (53) | 0.000 | 0.000 | 1.000 |
| continuity (13) | 0.500 | 0.500 | 1.000 |
| duration_math (53) | 1.000 | 1.000 | 1.000 |
| pills (4) | 1.000 | 1.000 | 1.000 |
| prompt_format (62) | 0.645 | 0.661 | 1.000 |
| cost_sanity (53) | 1.000 | 1.000 | 1.000 |
| reply_text (88) | 1.000 | 1.000 | 1.000 |
| no_narration (88) | 0.398 | 1.000 | 1.000 |
| mature_routing (2) | 1.000 | 1.000 | 1.000 |
| **Mean of graders** | **0.751** | **0.816** | **1.000** |

The fields the new schema asks for cannot be sent to the previous harness (it requires `visual`), so there is no "before, fields" column.

Recorded live transcripts (DeepSeek V4.1 Flash on the harness of 2026-11-25, 52 cases, graded as stored):

| Grader | 11:29 run | 11:33 run | 11:34 run |
|---|---|---|---|
| structure | 0.942 | 0.923 | 1.000 |
| shots_structured | 0.000 | 0.000 | 0.000 |
| duration_math | 1.000 | 1.000 | 1.000 |
| prompt_format | 0.665 | 0.680 | 0.692 |
| cost_sanity | 0.966 | 0.968 | 0.969 |
| reply_text | 0.904 | 0.885 | 0.788 |
| no_narration | 0.635 | 0.731 | 0.731 |
| **Mean** | **0.730** | **0.741** | **0.740** |

What the recorded runs show: tool narration in 27 to 37% of turns ("I'll check the video models and their lengths before planning."), credit numbers in the reply next to a plan in 10 to 21% ("2,081 credits"), keyframe prompts of 180 to 255 words because of the script text, and no structure to hold continuity on.

How to read these numbers: the scripted column proves what the harness guarantees when the model fills the schema correctly. It says nothing about how well DeepSeek fills it. The recorded column is the real model on the old harness. The real "after" needs a live run.

### What needs a live run

1. `pnpm --filter @rolling/agent eval:live`, then `eval:score -- --replay` on the result: does DeepSeek V4.1 Flash fill shot fields well (subject and action quality, cast discipline, one move per shot), how many retries the new checks cost, and tokens per turn with the longer prompt and schema.
2. `continuity`, clarify and small-talk cases: only a real model can fail them in interesting ways.
3. The mature classifier path: offline runs use the deterministic rules with a classifier that rates everything safe.
4. Generation quality per family: the adapters follow the vendor guides, but nothing was generated. Compare composed against free-text prompts on a few shots per family before trusting the assumed limits in `families.ts` (marked `// assumed`): the character caps for Seedance, MiniMax, Grok, Seedream, Qwen and Z-Image, the "No BGM" default when sound is on, and whether Seedance 2.5 reads better with timestamps for two-beat shots.
5. Character reference pictures: whether Seedream edit mode holds a face from the sheet across keyframes well enough to justify one extra picture per character.

## 5. Links

- Seedance 2.5 prompt guide: https://docs.byteplus.com/en/docs/modelark/seedance-2-5-prompt-guide
- Seedance 2.0 prompt guide: https://docs.byteplus.com/en/docs/modelark/seedance-2-0-prompt-guide
- Seedream prompt guide: https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide
- Alibaba Model Studio video prompt guide (Wan 2.5 to 3.0): https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt
- Wan 2.1 `prompt_extend.py`: https://github.com/Wan-Video/Wan2.1/blob/main/wan/utils/prompt_extend.py
- Wan 2.2 `system_prompt.py`: https://github.com/Wan-Video/Wan2.2/blob/main/wan/utils/system_prompt.py
- Wan default negative prompt: https://github.com/Wan-Video/Wan2.1/blob/main/wan/configs/shared_config.py
- MiniMax camera cheat sheet: https://hailuoai.video/pages/blog/camera-movement-prompt-cheatsheet
- MiniMax H3 prompt guide (third party): https://hackernoon.com/minimax-h3-prompt-guide-how-to-write-better-hailuo-30-video-prompts
- Sora 2 prompting guide: https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide
- Runway prompt guide: https://academy.runwayml.com/prompt-guide
- LTX-Video prompt enhancer: https://github.com/Lightricks/LTX-Video/blob/main/ltx_video/utils/prompt_enhance_utils.py
- HunyuanVideo prompt rewrite: https://github.com/Tencent-Hunyuan/HunyuanVideo/blob/main/hyvideo/prompt_rewrite.py
- CogVideoX prompt converter: https://github.com/zai-org/CogVideo/blob/main/inference/convert_demo.py
- Qwen-Image prompt tools: https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils.py
- xAI video generation: https://docs.x.ai/developers/model-capabilities/video/generation
- ViMax: https://github.com/HKUDS/ViMax and https://arxiv.org/abs/2606.07649
- MovieAgent: https://github.com/showlab/MovieAgent and https://arxiv.org/abs/2503.07314
- FilmAgent: https://github.com/HITsz-TMG/FilmAgent and https://arxiv.org/abs/2501.12909
- Mora: https://github.com/lichao-sun/Mora
- MoneyPrinterTurbo: https://github.com/harry0703/MoneyPrinterTurbo
- Anthropic, Writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- OpenAI function calling guide: https://developers.openai.com/api/docs/guides/function-calling
