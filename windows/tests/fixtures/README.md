# Reviewed Island English source

`island-english-reviewed.json` is a test-only snapshot of the English Island
copy that has been reviewed alongside Ukrainian, Polish, and Russian. The test
compares stable translation keys and English values with this independent
fixture so an English wording change cannot silently bypass translation review.

When English Island wording intentionally changes:

1. Review and update the corresponding `uk`, `pl`, and `ru` catalog values and
   keep each placeholder set unchanged.
2. Run `npm test` and verify the affected runtime phrases.
3. Regenerate the fixture from `windows` with:

   ```sh
   node --experimental-strip-types --input-type=module -e 'import {writeFileSync} from "node:fs"; import {ISLAND_ENGLISH} from "./src/core/i18n.ts"; writeFileSync("./tests/fixtures/island-english-reviewed.json", JSON.stringify(ISLAND_ENGLISH, null, 2) + "\n");'
   ```

4. Include the fixture update with the reviewed dictionary changes. Never update
   this snapshot without checking the three translations first.
