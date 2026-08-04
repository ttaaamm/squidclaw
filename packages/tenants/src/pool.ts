import { join } from "node:path";
import type { Tenant, TenantStore } from "./store.js";

export interface TenantWorkspace {
  tenantId: string;
  /** Each tenant's body lives in its own directory — memories, habits, reflexes. */
  dir: string;
}

/**
 * One organism per tenant, built on demand and kept warm.
 *
 * The builder is injected so this package never has to know what an Agent is —
 * tenants care about isolation and quotas, not about how a mind is assembled.
 */
export class AgentPool<T> {
  private live = new Map<string, T>();

  constructor(
    private tenants: TenantStore,
    private root: string,
    private build: (workspace: TenantWorkspace, tenant: Tenant) => T | Promise<T>,
  ) {}

  workspaceFor(tenantId: string): TenantWorkspace {
    return { tenantId, dir: join(this.root, tenantId) };
  }

  async for(tenantId: string): Promise<T> {
    const existing = this.live.get(tenantId);
    if (existing) return existing;

    const tenant = this.tenants.find(tenantId);
    if (!tenant) throw new Error(`unknown tenant "${tenantId}"`);
    if (!tenant.enabled) throw new Error(`tenant "${tenant.name}" is disabled`);

    const built = await this.build(this.workspaceFor(tenantId), tenant);
    this.live.set(tenantId, built);
    return built;
  }

  /** The warm instance if one exists — never builds. For steering peeks. */
  peek(tenantId: string): T | undefined {
    return this.live.get(tenantId);
  }

  /** Drops a tenant's warm instance — call after changing its plan or workspace. */
  evict(tenantId: string): void {
    this.live.delete(tenantId);
  }

  size(): number {
    return this.live.size;
  }
}
