# 11. Self-filled dust orders farmed the keeper reward

**Severity: Low**. Status: **fixed**. Audited commit `b566320`. PoC: `poc_f11_self_fills_do_not_farm_the_keeper_reward`.

The fix for 07 required a winner; a client filling its own dust order with its own firm still earned
0.02 USDC per settlement for about 0.012 USDC of storage. A fill now pays the keeper only if Tontine's fee
on it covers the reward; liquidations and epoch ticks still pay it.
