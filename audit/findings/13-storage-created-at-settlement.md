# 13. Ledger entries created at settlement were paid by nobody

**Severity: Low** (bounded by the storage the client pays when posting). Status: **fixed, one case left**.
Audited commit `b566320`.

The client's entry in the ledger it will be paid in is now created, and charged, when it posts the order;
Tontine's own entries are created once at initialisation; a reveal charges its owner. Left: the asset
entries of shareholders created when a firm with NEAR is wound up (a few per firm closing).
