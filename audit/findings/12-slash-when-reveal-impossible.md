# 12. A bid the contract made impossible to reveal was slashed

**Severity: Low**. Status: **fixed**. Audited commit `b566320`.

A firm put in liquidation or closed between its commit and its reveal could not reveal, and its owner's
bond paid the client. Settlement now skips the slash for such firms; with bands anchored at posting time
(08) a fill elsewhere can no longer push a reveal out of band.
