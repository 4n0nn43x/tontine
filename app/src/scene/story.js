// The replay shown on the landing page. Every name and figure comes from a real `make demo` run
// (local sandbox, protocol 86, 27/27 checks, NEAR replayed at 5.347 USD). Times are in seconds from the
// start of the loop.

// Where each firm floats, as [x, y] fractions of the viewport and a distance from the camera:
// screen/dist frame the copy on wide screens, arena/arenaDist gather the swarm when the copy is hidden
// ("Watch the swarm"), screenMobile/distMobile are for portrait screens.
export const FIRMS = [
  { name: "Undercut & Co", color: "#9fd0ff", priceSlot: "right", screen: [0.075, 0.41], dist: 40, arena: [0.2, 0.43], arenaDist: 34, screenMobile: [0.16, 0.42], distMobile: 32 },
  { name: "Cost Plus Ltd", color: "#a9f2cb", screen: [0.1, 0.66], dist: 15, arena: [0.3, 0.66], arenaDist: 17, screenMobile: [0.13, 0.69], distMobile: 12 },
  { name: "Gambler Inc", color: "#ffb48c", screen: [0.9, 0.67], dist: 14, arena: [0.7, 0.66], arenaDist: 17, screenMobile: [0.87, 0.7], distMobile: 12 },
  { name: "Premium Partners", color: "#d7bcff", priceSlot: "left", screen: [0.925, 0.41], dist: 40, arena: [0.8, 0.43], arenaDist: 34, screenMobile: [0.84, 0.43], distMobile: 32 },
  { name: "Sniper Holdings", color: "#ffe39d", screen: [0.185, 0.365], dist: 74, arena: [0.5, 0.4], arenaDist: 60, screenMobile: [0.5, 0.39], distMobile: 70 },
  { name: "Atlas AI", color: "#5ee6c8", screen: [0.3, 0.8], dist: 13, arena: [0.38, 0.8], arenaDist: 14, screenMobile: [0.3, 0.8], distMobile: 12 },
];

// Slots for firms that are not house firms (third-party strategies), used in live mode.
export const EXTRA_SLOTS = [
  { color: "#9ff0ff", screen: [0.3, 0.8], dist: 13, arena: [0.38, 0.8], arenaDist: 14, screenMobile: [0.3, 0.8], distMobile: 12 },
  { color: "#ffc6e8", screen: [0.7, 0.8], dist: 13, arena: [0.62, 0.8], arenaDist: 14, screenMobile: [0.7, 0.8], distMobile: 12 },
  { color: "#c8ff9f", screen: [0.85, 0.3], dist: 70, arena: [0.65, 0.33], arenaDist: 60, screenMobile: [0.75, 0.33], distMobile: 60 },
];

export const STORY = [
  { at: 0, do: "reset" },

  // Order #0: a client buys NEAR with 40 USDC, at least the 1Click quote. The best quote fills at the second best.
  { at: 1.5, do: "order", id: 0, side: "Buy", amount: "40.00 USDC", min: "7.4621 NEAR" },
  { at: 3.4, do: "commit", firm: "Undercut & Co" },
  { at: 3.75, do: "commit", firm: "Cost Plus Ltd" },
  { at: 4.1, do: "commit", firm: "Atlas AI" },
  { at: 6.2, do: "reveal", firm: "Atlas AI", price: "7.4726 NEAR" },
  { at: 6.5, do: "reveal", firm: "Undercut & Co", price: "7.4778 NEAR" },
  { at: 6.8, do: "reveal", firm: "Cost Plus Ltd", price: "7.4763 NEAR" },
  { at: 8.6, do: "win", firm: "Undercut & Co", price: "7.4763 NEAR", note: "+19.0 bp vs 1Click 7.4621" },
  { at: 10.0, do: "fill", firm: "Undercut & Co", price: "7.4763 NEAR", edge: "0.0160", dividends: "0.0048" },
  { at: 12.6, do: "orderEnd" },

  // Order #2: Premium Partners seals a quote and never reveals it: its owner's bond pays the client.
  { at: 13.8, do: "order", id: 2, side: "Buy", amount: "20.00 USDC" },
  { at: 15.5, do: "commit", firm: "Premium Partners" },
  { at: 15.85, do: "commit", firm: "Cost Plus Ltd" },
  { at: 17.6, do: "reveal", firm: "Cost Plus Ltd", price: "3.7385 NEAR" },
  { at: 19.2, do: "slash", firm: "Premium Partners", bond: "1.00" },
  { at: 21.2, do: "orderEnd" },

  // Order #3: a hijacked agent bids 50% off; the owner's price band refuses it at reveal, on chain.
  { at: 22.2, do: "order", id: 3, side: "Buy", amount: "20.00 USDC" },
  { at: 23.9, do: "commit", firm: "Cost Plus Ltd" },
  { at: 25.6, do: "refused", firm: "Cost Plus Ltd", label: "50% off · outside the band", line: "50%-off bid · <b>refused</b> by the owner's band" },
  { at: 27.4, do: "orderEnd" },

  // Order #4: Gambler Inc buys NEAR from every seller and spends its cash under the 40 USDC floor.
  { at: 28.4, do: "order", id: 4, side: "Sell", amount: "4.0000 NEAR", min: "21.33 USDC" },
  { at: 30.1, do: "commit", firm: "Gambler Inc" },
  { at: 30.45, do: "commit", firm: "Cost Plus Ltd" },
  { at: 30.8, do: "commit", firm: "Undercut & Co" },
  { at: 31.15, do: "commit", firm: "Atlas AI" },
  { at: 32.9, do: "reveal", firm: "Atlas AI", price: "21.36 USDC" },
  { at: 33.2, do: "reveal", firm: "Undercut & Co", price: "21.37 USDC" },
  { at: 33.5, do: "reveal", firm: "Gambler Inc", price: "21.38 USDC" },
  { at: 33.8, do: "reveal", firm: "Cost Plus Ltd", price: "21.34 USDC" },
  { at: 35.3, do: "win", firm: "Gambler Inc", price: "21.37 USDC" },
  { at: 36.7, do: "fill", firm: "Gambler Inc", price: "21.37 USDC", edge: "0.0643", dividends: "0.0193" },
  { at: 39.2, do: "orderEnd" },

  // Two epochs with its cash under the floor (27.92 USDC), then a liquidation sold by the same auction code.
  { at: 40.2, do: "epoch", firm: "Gambler Inc", n: 1, of: 2 },
  { at: 42.0, do: "epoch", firm: "Gambler Inc", n: 2, of: 2, liquidating: true },
  { at: 43.6, do: "commit", firm: "Undercut & Co", target: "Gambler Inc" },
  { at: 43.95, do: "commit", firm: "Premium Partners", target: "Gambler Inc" },
  { at: 44.3, do: "commit", firm: "Sniper Holdings", target: "Gambler Inc" },
  { at: 46.0, do: "reveal", firm: "Sniper Holdings", price: "0.50 USDC" },
  { at: 46.3, do: "reveal", firm: "Premium Partners", price: "6.00 USDC" },
  { at: 46.6, do: "reveal", firm: "Undercut & Co", price: "1.00 USDC" },
  { at: 48.1, do: "takeover", buyer: "Premium Partners", target: "Gambler Inc", price: "1.00 USDC", fee: "0.02", holders: "28.90 USDC", near: "7.9988" },
  { at: 50.4, do: "keys", target: "Gambler Inc" },

  // The firm contract enforces its budget on chain.
  { at: 52.2, do: "refused", firm: "Undercut & Co", label: "spend 21.00 > 20.00 · refused", line: "spend 21.00 on a 20.00 budget · <b>refused</b>" },
  { at: 55.0, do: "done", checks: "27/27" },
];

export const STORY_LENGTH = 58;
