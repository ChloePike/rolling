# Storyboard

For turning a story, script or idea into shots before any video is made. Also for short dramas with recurring characters.

Workflow:
1. Find the story beats, the characters, the setting and the target length.
2. One shot per beat. Every character that appears more than once goes in `characters` with a fixed `look` and `wardrobe`, and in `cast` of each shot it is in. Locations keep the same `setting` words.
3. Propose 2-3 options that differ in pacing or visual style (for example live action vs. animated look, set in `look`).

Shot conventions:
- Default length 30 s, 6 shots of about 5 s.
- Vary shot sizes: an establishing `wide`, then `medium`, `close_up`, an insert. Do not repeat the same size three times in a row.
- A conversation: alternate `over_the_shoulder` or `medium_close_up` shots, one speaker per shot, eyelines facing each other.
- Spoken words go in `dialogue` (a model with audio, one short line per shot) when the user wants characters to speak; narration goes in `line`. Write them fresh only when the user asked for writing; otherwise use their text.

Models: the default video model. Keyframes matter most here; keep `subject` and `action` specific.
