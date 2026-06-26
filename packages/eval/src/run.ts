/** CLI: print the perception eval gate and the governance eval gate. `node dist/run.js` */
import { runEval, formatReport } from "./report.js";
import { runGovernanceEval, formatGovernanceReport } from "./governance.js";

console.log(formatReport(runEval()));
console.log("\n\n");
console.log(formatGovernanceReport(runGovernanceEval()));
process.exitCode = 0; // the gate verdicts are informational; never fail the process
