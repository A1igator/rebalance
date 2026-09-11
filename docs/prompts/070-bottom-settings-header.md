# Bottom Settings with its header attached

Date: 2026-09-10

## Human clarification

“settings still should be at the bottom. just open up with the top of it attached. the part that says \"settings\"”

## Plan before implementation

Correct the top-of-page interpretation in prompt 069. Place Settings at the bottom when closed. Expand the whole bottom-anchored section upward, keeping its header immediately above the settings rows throughout the animation. Keep the section outside chart layout and reserve only the collapsed header height so the ring never moves on toggle. Preserve Back fixes, accessibility, reduced motion and all wallet/trading state. Update the existing layout assertions, check the retained live browser open/closed geometry, and commit/push main.

Tenjin search was unavailable with NETWORK_ERROR.

## Additional request and outcome

The user also asked: “and revert positioning of start and address”. The chart markup and layout were restored to e9ced56 (the bottom Settings version), preserving the original top-right controls; their navigation/control CSS had not changed in prompt 069. The selector Back fix remains intact. Live browser geometry and screenshot verified bottom placement, header attached above its rows, and stationary chart/controls.
