# Companion navigation and anchored Settings verification

Date: 2026-09-10

## Human requests

- “the UI stuff still wasn’t fixed? like back button to portfolio and settings. unless I’m in the wrong localhost”
- “close all the older UI tabs I have”
- Earlier: Settings opens with its header at the top, without moving the pie chart.

## Plan before implementation

1. Inspect live ports and current browser document; close older Rebalance UI tabs while retaining one current companion and unrelated browsing. Report any browser-control limitation honestly.
2. Fix selector connection state restored by browser Back, and ignore old asynchronous connection results after page navigation. Preserve the initial attachment baseline and wallet setup intent.
3. Anchor Settings header in place with animated content beneath it, outside chart layout. Keep chart dimensions stable and honor reduced motion.
4. Use isolated focused tests and the actual in-app page to verify navigation, usable portfolio cards and stationary Settings/chart geometry. Commit and push main.

No wallet creation, signing, trading start/stop, targets or credentials are part of this task.

## Initial findings

Current main is f12326f. A selector connection attempt leaves connecting=true across BFCache restoration; restored cards may remain disabled. Existing Settings CSS anchors the entire expanding section to the bottom, moving the header upward. Live chart servers listen on 4663, 4664 and 4665, with an older preview on 4770. Source fixes alone do not prove an older open document has loaded them.

The required Tenjin search returned NETWORK_ERROR; no shelf result was available.
