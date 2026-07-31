/**
 * @lattice/robots — a minimal robots.txt navigation gate, borrowed in spirit
 * from Lightpanda's `--obey-robots`. Zero runtime deps; the transport is
 * injected so the robots.txt fetch rides the same egress chokepoint as browser
 * traffic. Consumed by the serve wiring, which passes a `RobotsChecker` into the
 * governed navigation path as the structural `RobotsCheckerPort` (@lattice/action).
 */

export { parseRobots, isAllowed, selectGroup, patternToRegExp } from "./parser.js";
export type { RobotsRules, Group, Rule, RuleType } from "./parser.js";
export { RobotsChecker } from "./checker.js";
export type { RobotsCheckerOptions, RobotsFetch, RobotsResponse } from "./checker.js";
