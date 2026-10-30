// The replay shown on the landing page. Every name and figure comes from a real `make demo` run
// (local sandbox, protocol 86, 21/21 checks). Times are in seconds from the start of the loop.

// Where each firm floats, as [x, y] fractions of the viewport and a distance from the camera:
// screen/dist frame the copy on wide screens, arena/arenaDist gather the swarm when the copy is hidden
// ("Watch the swarm"), screenMobile/distMobile are for portrait screens.
export const FIRMS = [
  { name: "Undercut & Co", color: "#9fd0ff", screen: [0.075, 0.41], dist: 40, arena: [0.2, 0.43], arenaDist: 34, screenMobile: [0.16, 0.42], distMobile: 32 },
  { name: "Cost Plus Ltd", color: "#a9f2cb", screen: [0.1, 0.66], dist: 15, arena: [0.3, 0.66], arenaDist: 17, screenMobile: [0.13, 0.69], distMobile: 12 },
  { name: "Gambler Inc", color: "#ffb48c", screen: [0.9, 0.67], dist: 14, arena: [0.7, 0.66], arenaDist: 17, screenMobile: [0.87, 0.7], distMobile: 12 },
  { name: "Premium Partners", color: "#d7bcff", screen: [0.925, 0.41], dist: 40, arena: [0.8, 0.43], arenaDist: 34, screenMobile: [0.84, 0.43], distMobile: 32 },
  { name: "Sniper Holdings", color: "#ffe39d", screen: [0.185, 0.365], dist: 74, arena: [0.5, 0.4], arenaDist: 60, screenMobile: [0.5, 0.39], distMobile: 70 },
];

// The job orb: above the copy in the hero view, in the middle of the arena when exploring.
export const JOB = { screen: [0.5, 0.165], dist: 32, arena: [0.5, 0.25], arenaDist: 26, screenMobile: [0.5, 0.15], distMobile: 32 };

export const STORY = [
  { at: 0, do: "reset" },

  // Job #0: a reverse Vickrey auction between four firms.
  { at: 1.5, do: "job", id: 0, budget: "10.00", brief: "Translate a README to French" },
  { at: 3.4, do: "commit", firm: "Undercut & Co" },
  { at: 3.75, do: "commit", firm: "Cost Plus Ltd" },
  { at: 4.1, do: "commit", firm: "Premium Partners" },
  { at: 4.45, do: "commit", firm: "Sniper Holdings" },
  { at: 6.2, do: "reveal", firm: "Sniper Holdings", price: "7.00" },
  { at: 6.5, do: "reveal", firm: "Premium Partners", price: "8.50" },
  { at: 6.8, do: "reveal", firm: "Cost Plus Ltd", price: "3.52" },
  { at: 7.1, do: "reveal", firm: "Undercut & Co", price: "5.50" },
  { at: 8.6, do: "win", firm: "Cost Plus Ltd", price: "5.50" },
  { at: 9.8, do: "work", firm: "Cost Plus Ltd" },
  { at: 13.2, do: "verdict", firm: "Cost Plus Ltd", accept: true },
  { at: 13.6, do: "pay", firm: "Cost Plus Ltd", price: "5.50", firmShare: "3.85", dividends: "1.65" },
  { at: 16.4, do: "jobEnd" },

  // Job #1: the gambler underbids, delivers nothing and loses its owner's bond.
  { at: 17.6, do: "job", id: 1, budget: "4.00", brief: "Three unit tests for a parser" },
  { at: 19.3, do: "commit", firm: "Gambler Inc" },
  { at: 19.65, do: "commit", firm: "Cost Plus Ltd" },
  { at: 20.0, do: "commit", firm: "Undercut & Co" },
  { at: 20.35, do: "commit", firm: "Premium Partners" },
  { at: 22.0, do: "reveal", firm: "Gambler Inc", price: "1.20" },
  { at: 22.3, do: "reveal", firm: "Cost Plus Ltd", price: "3.28" },
  { at: 22.6, do: "reveal", firm: "Premium Partners", price: "3.40" },
  { at: 22.9, do: "reveal", firm: "Undercut & Co", price: "2.20" },
  { at: 24.3, do: "win", firm: "Gambler Inc", price: "2.20" },
  { at: 25.4, do: "work", firm: "Gambler Inc", empty: true },
  { at: 28.0, do: "verdict", firm: "Gambler Inc", accept: false },
  { at: 28.4, do: "slash", firm: "Gambler Inc", bond: "5.00" },
  { at: 30.6, do: "jobEnd" },

  // Two epochs under the treasury floor, then a liquidation sold by the same auction code.
  { at: 31.6, do: "epoch", firm: "Gambler Inc", n: 1 },
  { at: 33.4, do: "epoch", firm: "Gambler Inc", n: 2, liquidating: true },
  { at: 35.0, do: "commit", firm: "Sniper Holdings", target: "Gambler Inc" },
  { at: 35.35, do: "commit", firm: "Premium Partners", target: "Gambler Inc" },
  { at: 37.0, do: "reveal", firm: "Premium Partners", price: "8.00" },
  { at: 37.3, do: "reveal", firm: "Sniper Holdings", price: "5.00" },
  { at: 38.9, do: "takeover", buyer: "Premium Partners", target: "Gambler Inc", price: "5.00", fee: "0.10", holders: "5.90" },
  { at: 41.2, do: "keys", target: "Gambler Inc" },

  // The firm contract enforces its budget on-chain.
  { at: 43.0, do: "budget", firm: "Undercut & Co", spend: "21.00", budget: "20.00" },
  { at: 45.8, do: "done" },
];

export const STORY_LENGTH = 49;
