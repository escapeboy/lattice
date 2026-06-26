/** CLI: print the eval gate report. `node dist/run.js` */
import { runEval, formatReport } from "./report.js";

const report = runEval();
console.log(formatReport(report));
process.exitCode = 0; // the gate verdict is informational; never fail the process
