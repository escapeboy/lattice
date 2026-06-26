/** CLI: print the perception eval gate and the governance eval gate. `node dist/run.js` */
import { runEval, formatReport } from "./report.js";
import { runGovernanceEval, formatGovernanceReport } from "./governance.js";
import { runRecoveryEval, formatRecoveryReport } from "./recovery-eval.js";
import { runCacheEval, formatCacheReport } from "./cache-eval.js";
import { runRecipeEval, formatRecipeReport } from "./recipe-eval.js";

async function main(): Promise<void> {
  console.log(formatReport(runEval()));
  console.log("\n\n");
  console.log(formatGovernanceReport(runGovernanceEval()));
  console.log("\n\n");
  console.log(formatRecoveryReport(runRecoveryEval()));
  console.log("\n\n");
  console.log(formatCacheReport(runCacheEval()));
  console.log("\n\n");
  console.log(formatRecipeReport(await runRecipeEval()));
}

void main();
process.exitCode = 0; // the gate verdicts are informational; never fail the process
