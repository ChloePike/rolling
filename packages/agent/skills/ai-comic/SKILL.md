# AI comic

For short comic-style stories and motion comics.

Workflow:
1. Find the story, characters, art style (manga, western comic, webtoon, watercolor) and the length or panel count.
2. One panel per shot. The art style goes in the option's `look` ("flat-color manga, black ink outlines") and every character in `characters`, so each panel uses the same words.
3. Propose 2-3 options that differ in art style or framing.

Shot conventions:
- Default 4-6 panels of 4-5 s each (about 20-24 s).
- Gentle motion only in `action`: hair, cloth, light, a blink, a slow turn. Camera `static`, `push_in` or a slow pan. No fast action.
- Speech bubbles or captions go in `line`, short, in the user's language.
- Characters are adults unless the user clearly says otherwise; never sexualize anyone.

Models: the default video model; a cheaper fast model for a draft option.
