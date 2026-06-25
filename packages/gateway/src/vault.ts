/**
 * In-process Vault — credentials never cross the model boundary.
 * Agents reference credentials by ID; the value flows engine→field only.
 */

import { randomUUID } from "node:crypto";

export interface VaultEntry {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  /** Password is stored but NEVER returned via any tool response. */
  readonly password: string;
}

export interface VaultStoreResult {
  id: string;
}

export class Vault {
  private readonly entries = new Map<string, VaultEntry>();

  store(label: string, origin: string, username: string, password: string): VaultStoreResult {
    const id = randomUUID();
    this.entries.set(id, { id, label, origin, username, password });
    return { id };
  }

  /** Returns entry WITHOUT the password field — for ID resolution. */
  listPublic(): Array<{ id: string; label: string; origin: string; username: string }> {
    return Array.from(this.entries.values()).map(({ id, label, origin, username }) => ({
      id, label, origin, username,
    }));
  }

  getPassword(id: string): string | undefined {
    return this.entries.get(id)?.password;
  }

  getUsername(id: string): string | undefined {
    return this.entries.get(id)?.username;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}
