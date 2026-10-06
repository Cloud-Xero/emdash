---
"emdash": patch
---

Fix plugin storage cursor behavior when the anchor row of an ordered page is deleted. `PluginStorageRepository.query()` now encodes the ordered field values into the cursor and compares subsequent pages against those values, so ascending walks no longer end early and descending walks no longer restart from the top. Legacy cursors that do not contain the field values still work, but will throw a clear invalid-cursor error if their anchor row has been deleted.
