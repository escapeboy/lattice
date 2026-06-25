/**
 * PolicyEditor — in-memory policy config with read/write.
 * Persists to a JSON file if a path is provided.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { PolicyConfig } from "./types.js";

const DEFAULT_POLICY: PolicyConfig = {
  allowedOrigins: [],
  egressAllowlist: [],
  prohibitedActions: ["captcha", "account.create", "hard_delete", "payment", "transfer"],
  requireGrant: ["submit", "form.submit", "delete", "checkout"],
};

export class PolicyEditor {
  private config: PolicyConfig;

  constructor(initial?: Partial<PolicyConfig>) {
    this.config = { ...DEFAULT_POLICY, ...initial };
  }

  get(): PolicyConfig {
    return { ...this.config };
  }

  update(patch: Partial<PolicyConfig>): PolicyConfig {
    this.config = {
      allowedOrigins: patch.allowedOrigins ?? this.config.allowedOrigins,
      egressAllowlist: patch.egressAllowlist ?? this.config.egressAllowlist,
      prohibitedActions: patch.prohibitedActions ?? this.config.prohibitedActions,
      requireGrant: patch.requireGrant ?? this.config.requireGrant,
    };
    return this.get();
  }

  async loadFromFile(path: string): Promise<void> {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PolicyConfig>;
    this.update(parsed);
  }

  async saveToFile(path: string): Promise<void> {
    await writeFile(path, JSON.stringify(this.config, null, 2), "utf8");
  }

  toKernelConfig() {
    return {
      allowedOrigins: this.config.allowedOrigins,
      egressAllowlist: this.config.egressAllowlist,
      prohibitedActions: this.config.prohibitedActions,
    };
  }
}
