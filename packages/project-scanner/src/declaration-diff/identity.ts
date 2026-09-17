import type { PublicApiMember } from "../declaration-surface/types.js";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function conditionPathIdentity(conditionPath: readonly string[]): string {
  return JSON.stringify(conditionPath);
}

export function entrypointIdentity(
  exportPath: string,
  conditionPath: readonly string[],
): string {
  return JSON.stringify([exportPath, conditionPath]);
}

export function declarationIdentity(name: string, facet: number): string {
  return JSON.stringify([name, facet]);
}

export function memberRole(member: PublicApiMember): string {
  switch (member.kind) {
    case "getter":
    case "setter":
    case "constructor":
    case "call-signature":
    case "construct-signature":
    case "index-signature":
      return member.kind;
    default:
      return "ordinary";
  }
}

export function memberIdentity(member: PublicApiMember): string {
  return JSON.stringify([member.name, member.static, memberRole(member)]);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}
