import type { ResourceInput } from "@agendia/domain/resource-catalog";

export type ResourceRequest = ResourceInput;
export type ResourceDto = Omit<ResourceInput, "description"> & {
  id: string; description: string | null; status: "active" | "suspended";
};
