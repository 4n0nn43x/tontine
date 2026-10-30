# 10. A fill turned lent cash into inventory that went to shareholders ahead of the lender

**Severity: Medium** (a lender repaid 0.35 of 10 USDC while the owner took the NEAR bought with it).
Status: **fixed**. Audited commit `b566320`. PoC: `poc_f10_lent_cash_stays_cash`.

## Fix

At reveal, a firm that owes lenders must keep that much cash after paying for a buy: lenders are repaid
from the stable treasury, which the firm cannot turn into NEAR. (An owner can still `spend` its budget:
that design limit is stated in the README.)
